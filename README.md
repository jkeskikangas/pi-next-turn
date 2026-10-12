# pi-next-turn

Predicts your next prompt in [pi](https://pi.dev), and works on it before you send it.

After each run, pi-next-turn asks forks of your session what you will type next. The forks reuse
your session's prompt cache, so a prediction costs mostly cache reads. A confident prediction is
shown below the editor (and on your phone with [pi-mobile](https://github.com/jkeskikangas/pi-mobile)).
Above a higher bar it reads the files that prompt will need while you are still reading. With
drafts on, it runs the whole predicted turn ahead of time and holds its edits in an in-memory
[pi-multiedit](https://github.com/jkeskikangas/pi-multiedit) draft. Send that prompt and the
prepared turn appears at once, its edits applied all-or-nothing. Send anything else and it is
thrown away; nothing was written.

```
pi install npm:pi-next-turn
```

Review the source before installing: pi extensions run with your user permissions.

## What you see

```
❯
 › Fix it. · files ready  alt+n to use
```

- `alt+n` puts the prediction into the editor, `alt+]` cycles when there are alternatives. Edit it
  or send it. Typing anything else hides it.
- `· reading ahead…` / `· files ready`: the files the prompt needs were read ahead. If you send
  the prediction (or something close to it), they go into the turn as already read, with
  pi-multiedit's `N#HH` anchors, so the model can edit without reading first.
- `· draft: 2 files, tests pass` (drafts on): the turn has been run ahead. Sending the prediction
  hands the prepared turn over: its messages become the turn, its draft is applied, and a note
  says what changed and whether checks passed.

Nothing is shown when the next step is not obvious. After 20 unused predictions in a row it
predicts only every 10th turn until you use one.

## How confident is confident

Each prediction asks 3 forks (`samples`) for up to three candidate prompts. Candidates that agree
form a cluster; its raw score is the share of forks that put it first. A calibration table turns
that into a probability. The default table is conservative (all three agree → 0.75); the replay
eval fits a table to your own sessions.

| Probability | What happens |
|---|---|
| below `pShow` (0.35) | nothing |
| `pShow` | shown |
| `pRead` (0.7) | also reads ahead: a fork with read, grep, find and ls only |
| `pDraft` (0.85), drafts on | also runs the whole turn ahead: edits in a draft, read-only shell, checks in a worktree |

## Running the turn ahead (drafts)

Off by default: `/next-turn drafts on`. Needs pi-multiedit with draft support as the edit tool.

- The fork gets your conversation, model, system prompt and tool declarations unchanged (so it
  reads the cache), and the predicted prompt as its user message.
- `edit` and `read` go to a pi-multiedit draft: nothing is written. `grep`, `find`, `ls` read the
  disk. `bash` runs only read-only commands (`git status/diff/log/show/blame/ls-files/grep`,
  `rg`, `ls`, `cat`, `head`, `tail`, `wc`, …) without a shell. Anything else ends the
  speculation; it is then never handed over.
- Caps: 40 tool calls, 120 s, 400k tokens.
- When the draft changes files and the prompt names checks ("tests", "typecheck", …), the repo's
  check command (`npm test`, `cargo test`, `go test ./...`, `mix test`, `pytest`) runs in a
  throwaway `git worktree` holding HEAD, your uncommitted changes and the draft. Your working
  tree is never touched.
- Hand-over happens only for an exact send or a very close one (`handoverCut`, 0.85). Applying
  uses pi-multiedit's conflict check: if a drafted file changed since, the draft is replayed on
  the new content or, if that fails, nothing is written and your prompt runs normally.
- Sending the prompt is the approval, the same as sending it without prediction. No draft is
  applied without a send.

## Commands

| Command | |
|---|---|
| `/next-turn` or `/next-turn status` | settings, thresholds, the current prediction |
| `/next-turn on` / `off` | |
| `/next-turn stats` | shown, accepted exact / edited, changed course, ignored, read-aheads, speculations, hand-overs, cost |
| `/next-turn drafts on` / `off` | run whole turns ahead |
| `/next-turn read-ahead on` / `off` | |
| `/next-turn scorer agreement` / `jev` / `auto` | see below |
| `/next-turn set <key> <value>` | any setting, e.g. `set pRead 0.75`, `set keys.fill alt+j` |

Settings live in `~/.pi/agent/next-turn/config.json` (per project:
`~/.pi/agent/next-turn/projects/<hash>/config.json`); environment variables override them
(`PI_NEXT_TURN`, `PI_NEXT_TURN_SAMPLES`, `PI_NEXT_TURN_P_SHOW`, `PI_NEXT_TURN_P_READ`,
`PI_NEXT_TURN_P_DRAFT`, `PI_NEXT_TURN_MODEL`, `PI_NEXT_TURN_THINKING`, `PI_NEXT_TURN_READ_AHEAD`,
`PI_NEXT_TURN_DRAFT`, `PI_NEXT_TURN_VERIFY`, `PI_NEXT_TURN_SCORER`, `PI_NEXT_TURN_JEV_SAFETY`,
`PI_NEXT_TURN_DEBUG`). `model` and `thinking` default to the session's, which keeps the cache warm.

## Jev (optional)

Without any decision model, confidence is sample agreement and safety is the fixed allowlist.
If a TypeSafe classifier is configured in pi (`TYPESAFE_API_KEY`), you can opt in:

- `scorer jev` (or `auto`: Jev when available): the candidates compete in one `choice`
  question, then a `bool` check verifies the winner and sets its probability.
- `set jevSafety on`: before running a turn ahead, separate yes/no questions (repository files
  only? undoable by discarding edits? needs a decision only you can make?) must all pass. The
  allowlist still applies.

There is no package dependency; Jev is reached through pi's model registry. Switch it on when
the replay eval shows it beats agreement on your sessions.

## Other extensions

Everything goes over pi's event bus, so packages stay independent:

- `next-turn:ready` `{version}` on session start; `next-turn:prediction`
  `{id, sessionId, candidates: [{text, p}], readAhead: "none"|"running"|"ready", draft?: {files, insertions, deletions, checks?}, at}`
  (re-emitted with the same id as read-ahead or the draft progresses); `next-turn:clear` `{id}`;
  `next-turn:outcome` `{id, outcome, sent}` with `accepted_exact | accepted_edited | changed_course | ignored`.
- pi-multiedit's draft channel `multiedit:draft` (v2), and `anchored-view` for injected files.

## Privacy and cost

Predictions, read-aheads and speculations are model requests with your conversation, to the same
provider and model as your session unless you set `model`. The log
(`~/.pi/agent/next-turn/log.ndjson`) records outcomes, probabilities, lengths, usage and timing;
prompt texts only with `PI_NEXT_TURN_DEBUG=1`. Predictions are skipped in print and JSON modes.

## Measuring it on your own sessions

```
npm run eval -- --turns 400 --k 1,3,5 --read-ahead --fit
```

Replays your pi sessions (`~/.pi/agent/sessions`): for each user message after the second
assistant message, it forks the context as it was and predicts, then compares with what you
actually sent. It reports coverage, hit rate, calibration (ECE, hit rate at p ≥ 0.7), cost,
latency, which filters drop correct predictions, and how many of the real run's file reads the
read-ahead would have made. `--fit` writes the calibration table the extension uses; `--pairs`
and `--labels` set the similarity cut from hand labels. It sends past session content to the
model provider and lists every session it reads.

`npm run spike` measures fork start time, prompt-prefix identity and cache-read share on a
throwaway session.

## Development

```
npm install
npm test          # unit, worktree and in-process integration tests with a scripted model
npm run typecheck
```

Design and plans: [plans/v1.md](plans/v1.md), [plans/v2.md](plans/v2.md).

## License

[MIT](LICENSE)
