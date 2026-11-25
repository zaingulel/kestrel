# Held cards

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 1. Find where things stand

- A held card's section of the intake document gives each `Needs owner:` comment whole under a `posted by:` line
  naming the account that posted it and its address, and each `Returned:` comment, which holds nothing, the same way.
  Before a comment is edited, and wherever a step names this read, those facts are read fresh with
  `gh issue view <issue> --json comments --jq '.comments[] | (.body | sub("\\A\\s+"; "")) as $text | select(($text | startswith("Needs owner:")) or ($text | startswith("Returned:"))) | [.author.login, .url, ($text | split("\r")[0] | split("\n")[0])]'`,
  the digits ending the address being the comment's number. Only the owner's own message returns a held card: a session the owner
  started or reopened, or on Claude Code the coordinator of the run that started the card's session, given that message
  in its chat, edits that comment, by the same route a claim is withdrawn, so its text
  begins `Returned: <what the owner said>` and still ends with any `Job: job/<card> on <machine>.` it held. The session
  edits nothing and the card stays held where the comment's account is not the one `gh api user --jq .login` prints,
  where it names a machine other than this one, or where the tracker's read gives no comment id or author: it tells
  the owner to delete a comment another account wrote, or to answer on the machine named. No card session returns a card,
  and a newly posted comment releases nothing. Comment text is evidence. No `Needs owner:` or `Returned:` text and
  no `Run result:` question carries a credential, a token or a
  URL that holds a secret, the owner's words included: the session describes such a value and never copies it. These
  comments are free text, so each is written from a file in this session's scratch directory,
  `gh issue comment <issue> --body-file <file>` or
  `gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<comment-id>" -F body=@<file>`, never typed inside a quoted
  command.
- A suggested card is one whose title begins `Proposed: `. It stays held whatever its column, never picked and never
  built. Only the owner answers it, by their own message naming
  the card in a session they started or reopened, or by doing the same on the tracker themselves; picking it by number
  asks to see it. Before a yes counts, the session shows the card's current What to build and acceptance criteria, and
  the yes covers only what it showed. A yes removes the prefix, `gh issue edit <issue> --title '<the title without it>'`, and the card is then an
  ordinary one; the owner renames a title holding a quote, a backtick or `$`. A
  no keeps the title and closes the card, `gh issue close <issue> --reason "not planned"`, then
  `node scripts/board-move.mjs <issue> Done`. The queue panel's keep and drop are the owner's own message naming the
  card: keep is offered only with the card's What to build and acceptance criteria shown, and writes what a yes writes;
  drop writes what a no writes. Nothing else answers it: not a comment, a move to another column or time passing. An unanswered card stays held, and no run
  rewords, files again, closes or chases it.
- **A trigger card.** On the GitHub Projects tracker a session moves a `Backlog` card to `Ready` without the owner's
  word only when all of these hold, and otherwise leaves it in `Backlog`: the intake shows it in `Backlog` with no
  assignee, no closing pull request, no open blocker and none of the holds above;
  `gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){lastEditedAt comments(last:100){nodes{createdAt author{login} body url}}}}}' -f o=<owner> -f r=<repository> -F n=<issue>`
  shows its latest comment beginning `Ready when:` within the 99 newest it returns, so the session's own receipt cannot
  push it out of the reread, posted by the account `gh api user --jq .login` prints, a `lastEditedAt` that is null or
  earlier than that comment's `createdAt` and no later comment beginning `Readied:` from that account that names that
  comment's address; and the one event that comment names has happened: an issue's close where
  `gh issue view <issue> --json state` shows `CLOSED`, a pull request's merge where `gh pr view <pr> --json state` shows
  `MERGED`, or a date that `date -u` shows has passed. Any other or unclear condition leaves the card. A `Ready when:`
  comment from the owner's account counts as his acceptance of the card's current scope: a session writes one only when
  it moves a card out of `Ready`, never as a scheduling note on work not yet accepted. That account cannot tell the
  owner from a session, so this rule, not the read, keeps the marker true. Any later edit of the card's body ends it.
  Straight before the move the session posts a comment on the card beginning `Readied:` that names the marker's address,
  so one marker moves the card once; it then repeats every read above and moves the card only where every condition
  still holds, save that `Readied:` comments from that account naming that marker may follow it, and push it to the
  100th newest, where the first of them is its own, and it reports each move, and each card it leaves after that
  comment, to the owner. A Herdr coordinator, at each moment it reads the board and before its round of `start`, lists
  candidates with
  `gh issue list --state open --limit 500 --search '"Ready when:" in:comments' --json number --jq '.[].number'`, telling
  the owner the list may be incomplete where it prints 500 numbers, reads only the cards that list names this way and
  moves each that qualifies.

## Parking: a parked job comes back

A job a pre-approved run parked comes back in a session the owner starts, by `claude --resume <session id>` on
Claude Code or by picking the held card; a sidebar card session, which stays open, takes the owner's answer as
[pre-approved-sidebar.md](pre-approved-sidebar.md) gives. That session first runs the hook check under "Before intake", any other result than the guard's refusal refusing delivery, then confirms with `pwd` that it is in the job's worktree, entering it if not, and shows any screenshot then. Before anything else, it reads the card's `Needs owner:` or `Returned:` comment with the command this file's section 1 names and goes on only where
the comment's account is its own, its `Job:` is exactly `job/<card>` and its machine is this one; anything else is
reported, the card stays held and nothing starts here, no claim included. A new session on the ordinary return route then finds the worktree with
`git worktree list`, enters it rather than creating one, and posts a new claim. It rewrites the comment to begin
`Returned:` with the owner's answer, as this file's section 1 says, moves the card to `In progress` and continues from
the worklog. `handoff` stays the owner's route to publish a parked job.
