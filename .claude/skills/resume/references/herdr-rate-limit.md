# Herdr rate limit

The [Herdr coordinator](herdr-lead.md#coordinator) reads this file whole when
**A refused GitHub read** in its "Coordinator" section sends it here.

`cards`, `unfinished` and `start` exit 6 when GitHub refuses a read for its rate limit, printing `"GitHub refused a
coordinator tracker read for quota; repeat it after <ISO>."` (the line between the quotes), and never wait; that `<ISO>`
is the time GitHub names. Where another command fails with a rate-limit message of GitHub, the time GitHub names is a
`retry-after` of some seconds from now or, with `x-ratelimit-remaining` 0, an `x-ratelimit-reset` in seconds since
1970, and it counts only as a number above 0 that makes a real date. A refusal that names such a time is waited out
until that time, a repeated refusal included. Where the refusal names no such time and its message says a secondary
rate limit was exceeded, it waits one minute, as GitHub directs, the first time that read is refused so. Every other
refusal it tells the owner with the command's own error, never repeats that read, and still waits one minute.

It waits by setting its alarm to that time, or acts at once as at the alarm's note where the time is at or before now.
Until the alarm's note it reads and writes nothing on GitHub, and this comes before the reads that **Sleeping** and
**Moments to read the board** in [herdr-lead.md](herdr-lead.md) and [herdr-stopped-job.md](herdr-stopped-job.md) call
for: at a wake or a turn end it reads only its jobs through Herdr, and it tells the owner who speaks meanwhile that
GitHub reads wait. At the note it repeats the refused read and carries on, unless it told the owner of that refusal: it
then sends no GitHub read on its own, at that note or any later wake, `cards` and `unfinished` included, until the owner
says to carry on. A command that may have written before its refusal, such as `board-claim`, is not repeated: it follows
that command's own read-back and recovery instructions.
