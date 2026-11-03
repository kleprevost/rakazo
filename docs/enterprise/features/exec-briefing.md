# Executive Assistant daily briefing

Track G, wave 2 of the AI Employee Experience work. The Executive Assistant (EA) role pack is the
first one that has to show value, so its morning briefing must be dependable and leave something
the user can open later, not just a chat message. Not linked from the public docs site.

## What the EA created before (template v1)

- A `daily-briefing` skill: five terse steps ("list meetings, flag conflicts, summarize unread
  email, top three things, under 200 words"). It named no sources, said nothing about missing apps,
  and produced only text.
- A paused `Morning briefing` routine (`30 7 * * 1-5`) whose prompt names the skill.
- A routine run is an ordinary bot run in the bot's thread, so the briefing was a chat message.
  Today's "completed" list only shows routine runs with their produced artifacts
  (`today.md`: `Artifact` joined by `runId`), so a text-only briefing had no file to open there.

## How a deliverable is made

The existing mechanism is the bot's own two tools: `write_file` (into its home) and `attach_file`
(`packages/adapters/src/run-tools-files.ts`). `attach_file` stores an `Artifact` with the current
`runId`, posts it to the thread, and lists it under Artifacts and in Today. Calling it again with
the same `name` adds a version of the same artifact. Markdown (`.md`) is a supported type. No new
tool, table or migration is needed; the skill just tells the bot to use them.

## Template v2 (`executive-assistant.json`, `version: 2`)

- New skill `executive-briefing` replaces `daily-briefing` (see compatibility). It states, without
  naming any product:
  1. Read-only, no exceptions: never send, reply, accept, decline, create, edit, move or delete.
  2. Use whatever calendar, email and task tools the bot actually has, whether connected apps or
     MCP servers (Microsoft 365 is reached through a remote MCP server in this deployment), and
     search its tools first when unsure.
  3. If a source is missing or a call fails, still write the briefing, list it under "Not
     available" with what it would have added, and never invent meetings, messages or tasks.
  4. A fixed structure: Today's schedule with prep notes; Needs your attention; Open commitments;
     Suggested actions (at most five, proposals only); Not available.
  5. Save `briefings/YYYY-MM-DD.md`, `attach_file` it as "Briefing YYYY-MM-DD" with a one-line
     description, and reply in chat with two or three lines (the one important thing and any gap).
- The routine prompt and starter task name `executive-briefing`, so the first briefing is also an
  artifact. The instructions gain one line: use the tools you have, say when one is missing.
- Connections stay provider-neutral kinds (`email`, `calendar`, read-only; `documents` optional).
  There is no `tasks` kind and the schema is unchanged; tasks are used when the bot happens to have
  a tool for them, and reported as not available otherwise. Adding a kind is a follow-up.
- Vendor names appear nowhere in the template or skill.

## Compatibility with already-hired bots

A hired bot keeps what it was created with, and nothing here rewrites it:

- Existing EA bots keep their instructions, their routine prompt (which names `daily-briefing`)
  and the `daily-briefing` skill in the owner's library. They do not get the update. Their
  briefing keeps working exactly as before, as chat text.
- Hiring skips a skill that already exists by name. Keeping the old name would have left every
  owner who had hired v1 on the old text for any later hire. The new name avoids that: new hires
  always get v2, old skills are untouched, and nothing is deleted.
- To adopt v2 an existing owner can hire a new EA, or ask the bot to use the `executive-briefing`
  skill (present once any v2 EA has been hired in the space). An in-place upgrade path for hired
  bots (a per-bot template version and an "Update role" action) is out of scope here.

## Tests

Deterministic and offline (`packages/core/src/role-templates/role-templates.test.ts`, the API hire
test, the web preview test): the catalog and schema still validate; the version is at least 2; the
skill tells the bot to save and `attach_file`; the routine prompt and starter task name the skill
(the existing test also checks the skill ships); hiring seeds `executive-briefing` and
`meeting-prep`, keeps an existing skill by name, and creates the routine paused. These assert
structure only, never the wording or quality of a briefing.

## Eval (opt-in, off by default)

`pnpm test:evals --suite briefing` (`packages/testkit/src/evals/briefing.ts`) runs the real shipped
template (instructions and skills, via the new `roleTemplate` case field) against fixture tools
for a fictional day: `CALENDAR_LIST_EVENTS` (new fake, read-only) and the existing inbox fake.
It never runs in `pnpm test` and needs a model connection; judge cost is reported separately.

| Case | Deterministic checks | Judged by rubric `briefing-meaning-v1` |
| --- | --- | --- |
| `briefing-all-sources` | calendar and inbox read, file saved, `attach_file` called, no write | structure, faithfulness to the fixture, proposals not actions, decision first |
| `briefing-calendar-unavailable` | calendar attempted and failed, file saved and attached, no write | says the calendar was unavailable, lists no meeting |

The rubric is versioned in code. `BRIEFING_JUDGE_CALIBRATION` holds reviewed examples (a faithful
briefing, an invented meeting, an action taken instead of proposed, an honest gap) for calibrating
the judge; a judge error counts as unqualified, not a pass. Offline unit tests cover the
deterministic grading only.

## Not in this PR

Per-bot template upgrades, a `tasks` connection kind, the Today UI (the Today-as-home work reads
the same artifacts), delivering the briefing to email or chat, and mobile.
