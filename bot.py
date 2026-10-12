"""First local Kestrel conversation trial."""

import asyncio

import torch
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import SmallWebRTCRunnerArguments
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from speech import EchoRemoval, NemotronSTT, ROOT, VoxCPMTTS

SYSTEM_PROMPT = (
    "You are Kestrel, Zain's local voice assistant. Speak naturally in concise English. "
    "Usually answer in one or two short sentences, beginning with a short complete sentence. "
    "Use plain spoken text without markdown, lists, or stage directions. "
    "This session is a conversation trial. You have no tools, desktop access, web access, "
    "or persistent memory. Be honest about that and never claim to have performed an action."
)
SESSION_LOCK = asyncio.Lock()
ECHO_REMOVAL = EchoRemoval()
VOICE_MODEL = None


def make_llm():
    return OpenAILLMService(
        api_key="lm-studio",
        base_url="http://192.168.0.150:1234/v1",
        settings=OpenAILLMService.Settings(
            model="underdog-saluki-27b-1.0", temperature=0.4, max_tokens=180,
            system_instruction=SYSTEM_PROMPT,
            extra={"reasoning_effort": "none"},
        ),
    )


async def bot(runner_args: SmallWebRTCRunnerArguments):
    global VOICE_MODEL
    if SESSION_LOCK.locked():
        logger.warning("A microphone session is already running; disconnecting the second client")
        await runner_args.webrtc_connection.disconnect()
        return
    async with SESSION_LOCK:
        stt = NemotronSTT()
        disconnected = asyncio.Event()

        @runner_args.webrtc_connection.event_handler("closed")
        async def on_closed(connection):
            disconnected.set()

        try:
            fault = await asyncio.to_thread(ECHO_REMOVAL.fault)
            if fault:
                logger.error(f"Refusing the microphone session: {fault}")
                return
            logger.info("Loading local speech models for the microphone session")
            await stt.load()
            torch.set_num_threads(4)
            if VOICE_MODEL is None:
                VOICE_MODEL = await asyncio.to_thread(
                    VoxCPM.from_pretrained, str(ROOT / ".runtime/models/voxcpm2"),
                    load_denoiser=False, optimize=False, device="cuda", local_files_only=True,
                )
            if not disconnected.is_set():
                await run_conversation(runner_args, stt, VOICE_MODEL)
        finally:
            await stt.close()
            await runner_args.webrtc_connection.disconnect()


async def run_conversation(runner_args, stt, voice):
    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    context = LLMContext([])
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(), empty_user_turn=None,
        ),
    )
    pipeline = Pipeline([
        transport.input(), stt, aggregators.user(), make_llm(),
        VoxCPMTTS(voice), transport.output(), aggregators.assistant(),
    ])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=16000, audio_out_sample_rate=48000,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_disconnect(transport, client):
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    logger.info("Kestrel is ready. Speak, pause for a reply, and interrupt naturally.")
    await runner.run()


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
