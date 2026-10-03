# CORE-180 task script

The facilitator reads the text in quotation blocks aloud, word for word. Everything
else is for the facilitator only. Keep [ground-truth.md](ground-truth.md) out of
the participant's sight.

Each session takes about 90 minutes: 10 minutes of introduction, two conditions of
at most 40 minutes of tasks each (plus a 3-minute warm-up), a short break and
5 minutes of closing questions.

## Before the participant arrives

1. Look up the participant's row in [ordering.csv](ordering.csv): which condition
   comes first and which variant (A or B) goes with each condition.
2. Check both environments: `./study-env.sh check baseline` and
   `./study-env.sh check new` must both print `"ready": true`.
3. Open a **fresh browser profile** (a new Chrome profile or a new incognito
   window) for the first condition. Cookies are scoped by host, not by port, so
   the two environments must never share a browser context. Use a 1440×900 window
   or larger.
4. Go to `<origin>/signin` for the first condition (`./study-env.sh origin <condition>`)
   and choose **Continue as priya**. Leave the browser on the repository home,
   `<origin>/priya/simple-git`.
5. Print or open the participant's prompt cards (the prompts below for the
   assigned variants) so they can be shown one at a time.
6. Prepare a blank copy of the recording sheet rows for this participant
   ([recording-sheet.csv](recording-sheet.csv)) and a stopwatch or clock with seconds.

## Consent and recording

> "Thanks for helping. We're comparing two versions of a code-exploration tool,
> not testing you. You can stop at any time, for any reason, and nothing you do
> here is a mistake: if something is hard, that tells us about the tool.
>
> With your permission I'll record the screen and audio. The recording and my notes
> are only used to analyse the study; they stay private, and in anything we write
> you'll be identified only as a participant number. Is it OK to record?"

Record verbal consent (yes/no) in the notes. Without consent, take notes only and
do not record. Do not record the participant's face.

## Introduction

> "You'll explore an open-source TypeScript library you haven't worked on: simple-git,
> a Node.js wrapper around the git command line. You'll use two versions of the
> same web app, one after the other, with four short tasks in each. The two sets of
> tasks are different but similar.
>
> Please use only this browser window and this app: no GitHub, no local clone of the
> code, no other AI tools. Anything inside the app is fair game, including the code
> browser and search.
>
> Each task has a time limit of 10 minutes. Say 'done' when you have your answer and
> tell it to me; I'll stop the clock when you say 'done'. If you're stuck you can
> say 'pass' and we'll move on. I can't help with the tasks, but I can repeat a
> question.
>
> Please think aloud as you work: say what you're looking for, what you expect to
> find, and what surprises or confuses you. If you go quiet I'll remind you."

Think-aloud reminders: after about 20 seconds of silence say only "What are you
thinking?" or "Keep talking, please." Do not suggest where to look, and do not
confirm or deny an answer until the session is over.

Before the first task, ask and record: years of professional experience, how often
they read unfamiliar code, whether they have used simple-git as a dependency, and
whether they have ever read its source or used Gitmatrix (screening: anyone who has
read or contributed to simple-git's source is not eligible).

## Warm-up (each condition, 3 minutes, not timed)

Navigate to `<origin>/marco/hello-world/knowledge` in the condition's own browser
context (signed in as priya) and read the condition's paragraph. Let the participant
click around for the rest of the 3 minutes. hello-world is a one-file repository: the
warm-up shows where the controls are, not how they behave on a real codebase. Then
navigate to `<origin>/priya/simple-git` and start the first task.

**Baseline**

> "This is the Knowledge tab. It shows a map of the repository's components and
> files; selecting one opens an inspector with its summary, what it uses and what
> uses it, and its key files. The search box finds files, symbols and concepts, and
> answers questions. The timeline picker shows what a timeline changes. The Code
> tab browses the source, and its file views link back here."

**New**

> "This is the Knowledge tab. It shows a map of the repository's capabilities;
> selecting one opens an inspector with its summary and where that came from, what
> it contains, and what it uses and what uses it. The outline view lists the same
> things as a tree. The lookup box finds capabilities, files and symbols. The
> timeline picker shows what a timeline changes. The Code tab browses the source,
> and its file views link back here."

## Timing and completion rules

- Show the prompt card and read it aloud. **Start the clock when you finish
  reading.** Stop it when the participant says "done" or "pass", or at 10:00.
- The answer is what the participant says (or points at) when they say "done". They
  may read file names and lines from the screen. Write it down verbatim, with every
  file path and line they cite.
- Record an outcome per task: `completed` (the answer meets the task's completion
  rule in [ground-truth.md](ground-truth.md)), `incorrect` (they said "done" but the
  answer doesn't meet the rule), `gave_up` ("pass") or `timeout` (10:00 reached).
  Score after the session from the notes and the recording, not while the
  participant watches.
- A task that isn't `completed` counts as **600 seconds** in the timing analysis,
  however quickly it ended: a fast wrong answer is never faster.
- Do not tell the participant whether an answer was right until the session ends.
- If the app fails (an error page, a blank map for over a minute), note the time
  and the symptom, and let the clock run: the tool's failures are part of the
  measurement. If the environment is down, stop the session and note it; that
  session is then repeated with a new participant.
- With a timeline selected, both conditions show a banner saying "priya has no
  timeline change-a": the bookmarks are plain branches, not tracker timelines. If
  asked, say only that it doesn't matter for the task.

## Prompts

Use the variant assigned to the condition. Prompts are self-contained: a later task
never depends on an earlier task's answer.

### Variant A

**A1. Find a capability**

> "simple-git refuses to run some git commands that could make git execute an
> arbitrary program (for example `git clone -u <command>`, or the `--upload-pack`
> option) unless the caller explicitly allows it. Find the part of this codebase
> responsible for that protection. Tell me in a sentence or two what it does, and
> name the main files that implement it."

**A2. Cite two sources**

> "Cite two source locations, as a file and a line or a named function or constant:
> first, where the list of command-line options that simple-git treats as unsafe is
> defined; second, where simple-git stops a command with an error when an unsafe
> option is found and the caller hasn't opted in."

**A3. Identify direct dependents**

> "Which files directly depend on `packages/argv-parser/src/flags/flags.helpers.ts`,
> meaning they import it themselves? List them."

**A4. Explain timeline changes**

> "A timeline called `change-a` proposes a change to this repository. Using the app,
> explain what it changes compared with main: which source files, what behaviour
> changes, and which part of the system it affects."

### Variant B

**B1. Find a capability**

> "simple-git can summarise a diff (the files changed, with insertions and
> deletions) through `git.diffSummary()`, and can attach the same kind of summary to
> the entries `git.log()` returns. Find the part of this codebase responsible for
> producing those summaries. Tell me in a sentence or two what it does, and name the
> main files that implement it."

**B2. Cite two sources**

> "Cite two source locations, as a file and a line or a named function or constant:
> first, where one line of `git diff --stat` output, such as `src/a.ts | 3 ++-`, is
> turned into a per-file entry with its insertions and deletions; second, where
> simple-git works out which summary format the caller asked for (`--stat`,
> `--numstat`, `--name-only` or `--name-status`) from the options passed."

**B3. Identify direct dependents**

> "Which files directly depend on `simple-git/src/lib/args/log-format.ts`, meaning
> they import it themselves? List them."

**B4. Explain timeline changes**

> "A timeline called `change-b` proposes a change to this repository. Using the app,
> explain what it changes compared with main: which source files, what behaviour
> changes, and which part of the system it affects."

## Between the conditions

Offer a short break. Close the first browser context completely, open a **new**
fresh profile or incognito window for the second condition's origin, sign in as
priya, run its warm-up, then its four tasks with its variant.

## Closing (5 minutes)

> "Thanks, that's everything. A few quick questions:
>
> 1. Which version would you rather use to get oriented in an unfamiliar codebase,
>    and why?
> 2. Which would you rather use to understand a proposed change, and why?
> 3. Was there a moment in either version where you didn't trust what you saw?"

Record the answers in the notes column of the participant's last row. Then you may
tell the participant the correct answers.

## After the session

Fill in the participant's 8 rows of [recording-sheet.csv](recording-sheet.csv) from
the notes and the recording, scoring each answer against
[ground-truth.md](ground-truth.md). Save the recording privately, named by
participant number only.
