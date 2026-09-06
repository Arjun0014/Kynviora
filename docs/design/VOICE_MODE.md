# Kynviora - Voice Mode

Status: product and engineering source of truth for the conversational layer.
Owner of the contracts: `packages/agent/src/`. **On conflict, the code wins.**

Spec precedence is unchanged. `17_AI_AND_AUTOMATION_POLICY.md` is binding and nothing here relaxes
it; `13`, `14`, `11`, `15`, `16` and `18` apply exactly as they do to every other surface.

---

## 1. What Voice Mode is

Voice Mode is **a way to operate Kynviora**, not a microphone shortcut and not a chatbot bolted to
the side. The target is that an older adult who finds a touchscreen difficult can do the ordinary
things - see what they are taking, record a dose, set a reminder, add an item, take a photograph of
a pack, hear what is missing, get to a screen - by saying so.

The one-line shape:

```
speech  ->  agent  ->  a typed proposal  ->  six gates  ->  the app's own client  ->  result
        ->  the Speech Gate  ->  spoken and shown, together
```

Two properties do all the work:

1. **The agent proposes; it never acts.** It returns a tool name and arguments. Everything after
   that is code in this repository.
2. **The agent's reach is the app's reach.** Every tool executes by calling the same
   `KynvioraClient` method a screen calls, on the same session. There is no second authorization
   path, no database handle, and no route the agent can construct.

---

## 2. What it must never become

From `17`'s prohibited list, restated as the rules this layer is built to enforce:

- **It may not prescribe, change, stop, split, replace or recommend a medication.** Not on request,
  not as a suggestion, not as a summary of one. There is no tool that expresses it, which is the
  strongest form the rule takes: it is an absence in the vocabulary rather than a filter over
  output. `registry.test.ts` asserts the absence.
- **It may not declare anything safe or unsafe**, or read an absence of a matched rule as approval.
- **It may not establish a fact.** Every fact it speaks came out of a tool result composed by this
  repository.
- **It may not write shared catalog or regulatory truth**, by any path, from any prompt.
- **It may not resolve caregiver authorization** or perform anything `14` puts behind a fresh
  identity confirmation.

And one rule that is Voice Mode's own: **a person must know what they are agreeing to.** The
summary read out before a write is composed by `packages/agent/src/summary.ts`, not by the model -
"shall I record that you took it" is one word from "shall I record that you skipped it", and both
are fluent.

---

## 3. The Agent Tool Registry

`packages/agent/src/registry.ts`. Every capability an agent may name, with six answers each. None
of the six has a default: a new tool cannot compile without all of them.

| Field          | Answers                                                          |
| -------------- | ---------------------------------------------------------------- |
| `effect`       | `READ` / `WRITE` / `NAVIGATE` / `DEVICE`                         |
| `capability`   | What the caller must hold, as the **server** last reported it    |
| `confirmation` | `NONE` or `EXPLICIT` - a summary spoken and shown, and agreed to |
| `stepUp`       | Whether `14`'s fresh identity confirmation is required           |
| `voice`        | `ALLOWED` or `TOUCH_ONLY`                                        |
| `offline`      | `ONLINE_ONLY` / `LOCAL_PROJECTION` / `QUEUES`                    |
| `surface`      | The screen it opens, so voice and touch stay one interface       |
| `blockedBy`    | The blocker preventing it from working, or `null`                |

### The inventory

| Tool                         | Effect   | Capability     | Confirm | Voice      | Offline    | Surface        |
| ---------------------------- | -------- | -------------- | ------- | ---------- | ---------- | -------------- |
| `list_medicines`             | READ     | VIEW_MEDICINES | -       | allowed    | projection | Shelf          |
| `list_personal_care`         | READ     | VIEW_PERS_CARE | -       | allowed    | projection | Shelf          |
| `describe_item`              | READ     | VIEW_MEDICINES | -       | allowed    | projection | Item detail    |
| `explain_what_is_missing`    | READ     | VIEW_MEDICINES | -       | allowed    | projection | Item detail    |
| `list_schedules`             | READ     | VIEW_MEDICINES | -       | allowed    | projection | Schedule sheet |
| `read_dose_history`          | READ     | VIEW_MEDICINES | -       | allowed    | projection | Dose sheet     |
| `record_dose`                | WRITE    | RECORD_DOSES   | yes     | allowed    | **queues** | Dose sheet     |
| `create_schedule`            | WRITE    | MANAGE_MEDS    | yes     | allowed    | queues     | Schedule sheet |
| `update_schedule`            | WRITE    | MANAGE_MEDS    | yes     | allowed    | queues     | Schedule sheet |
| `add_medicine`               | WRITE    | MANAGE_MEDS    | yes     | allowed    | online     | Add sheet      |
| `add_personal_care_item`     | WRITE    | MANAGE_PC      | yes     | allowed    | online     | Add sheet      |
| `update_item`                | WRITE    | MANAGE_MEDS    | yes     | allowed    | online     | Item detail    |
| `delete_item`                | WRITE    | **owner only** | yes     | touch only | online     | Item detail    |
| `list_safety_state`          | READ     | VIEW_ALERTS    | -       | allowed    | projection | Safety         |
| `describe_alert`             | READ     | VIEW_ALERTS    | -       | allowed    | projection | Safety         |
| `list_people`                | READ     | none           | -       | allowed    | projection | Care           |
| `list_caregiver_access`      | READ     | owner only     | -       | allowed    | online     | Care           |
| `invite_caregiver`           | WRITE    | owner only     | yes     | touch only | online     | Care           |
| `revoke_caregiver_access`    | WRITE    | owner only     | yes     | touch only | online     | Care           |
| `prepare_visit_pack`         | WRITE    | owner only     | yes     | touch only | online     | Today          |
| `export_my_data`             | WRITE    | owner only     | yes     | touch only | online     | You            |
| `record_consent`             | WRITE    | owner only     | yes     | touch only | online     | You            |
| `delete_account`             | WRITE    | owner only     | yes     | touch only | online     | You            |
| `open_screen`                | NAVIGATE | none           | -       | allowed    | projection | -              |
| `open_item`                  | NAVIGATE | VIEW_MEDICINES | -       | allowed    | projection | Item detail    |
| `start_package_capture`      | DEVICE   | MANAGE_MEDS    | **yes** | allowed    | online     | Camera         |
| `capture_next_package_photo` | DEVICE   | MANAGE_MEDS    | -       | allowed    | online     | Camera         |
| `read_extracted_fields`      | READ     | MANAGE_MEDS    | -       | allowed    | online     | Add sheet      |
| `confirm_extracted_item`     | WRITE    | MANAGE_MEDS    | yes     | allowed    | online     | Add sheet      |
| `list_pending_changes`       | READ     | none           | -       | allowed    | projection | Pending queue  |

`read_extracted_fields` and `confirm_extracted_item` are **blocked on `BLK-007`**. See section 7.

### Why the touch-only group is touch-only

Three reasons, and each covers a different set:

1. **`14` requires fresh identity.** The Visit Pack, the data export, caregiver administration,
   closing the account. Nothing in this build can re-authenticate by voice, and a spoken "yes" is
   a far weaker act than a typed password - in a room that, for a voice interface, usually has
   other people in it. Enforced twice: a `stepUp: true` tool is asserted to be `TOUCH_ONLY`, and
   the dispatcher refuses one that arrives by voice anyway.
2. **It removes a health record.** `delete_item`. Recoverable only within the retention window, and
   a misheard word is a plausible way to lose one.
3. **It is a legal act.** `record_consent`. A consent receipt records that somebody read a
   **specific versioned text**, and a voice interface cannot show anybody a text.

Touch-only does not mean absent. Each is in the registry so the agent can say **where the control
is** - a person asking to close their account is taken to the screen that does it, rather than told
the capability does not exist.

---

## 4. The six gates

`packages/agent/src/dispatcher.ts`, in this order, and the order is the design:

1. **Is it a tool?** An unknown name dies first, before any definition is read. A hallucinated tool,
   and every "change my dose" a model will ever propose, ends here.
2. **May voice reach it?** Before arguments, so a caller cannot learn what arguments a forbidden
   tool takes by watching which ones are rejected.
3. **Do the arguments typecheck?** Strictly, including refusing keys the tool does not declare - a
   model that invented `includeOtherHouseholds` is refused rather than having it dropped, because
   dropping it would run a call the summary also dropped it from.
4. **Does the caller hold the capability?** As the server last reported it. **This is not the
   authorization** - the route decides, every time, on the session (`11`, `13`). It is the same job
   `mayRecordDoses` already does on the shelf: stop offering what the write would refuse.
5. **Is identity fresh, and is there a network?**
6. **Has this exact proposal been confirmed?** Last, so the summary a person agrees to describes a
   call that has already passed everything else.

`dispatch` re-runs all six at execution time rather than trusting an earlier `checkCall`. The two
are separated by a person deciding something, which takes seconds - during which a session expires,
a network drops, or a grant is revoked.

---

## 5. The confirmation machine

`packages/agent/src/session.ts`. Four rules, each preventing a failure a voice assistant has
actually shipped:

1. **A confirmation is for one proposal.** `confirm` takes the proposal's own id. A confirmation
   naming a different one is refused **and disarms** - the two sides disagree about what is on the
   table, and the safe reading of that is neither.
2. **A confirmation expires**, ninety seconds, measured against a clock the caller supplies rather
   than the device's own - two device harnesses move that clock and so could anybody else.
3. **Anything that is not a confirmation cancels.** Starting to speak again disarms whatever was
   armed, so a "yes" inside the next sentence cannot land on the last one.
4. **The summary that was given is stored with the proposal.** What was agreed to is the sentence
   that was heard, not one regenerated at execution time.

Releasing and disarming happen in the same step, so a repeated word records one dose.

---

## 6. The Speech Gate

`packages/agent/src/speech.ts`. The Citation Gate's argument applied to speech:

> **Every fact Kynviora speaks came out of a tool result. Every other word came from a closed set
> of phrasings in this repository.**

A response is a list of parts, each either an `UTTERANCE` (a key into a fixed set of about fifteen
sentences, none of which says anything is safe, advisable or a good idea) or `COMPOSED` (text that
must appear **exactly** in the tool result it came from - substring matching would let "no matched
rule was found within coverage" become "no rule found", and the missing words are the ones doing
the work).

The assembled sentence is then scanned by `findForbiddenClaims`, because a combination can say
something neither half said and this is the only place the whole sentence exists.

**What this costs.** Fluency. Kynviora sounds composed rather than chatty, and it cannot answer a
question no tool answers - it says so. **What it buys.** There is no path, including a jailbroken or
prompt-injected one, by which a sentence about somebody's medicine reaches their ears without
having been composed here. `17` already treats an uploaded package, a webpage and a regulatory PDF
as untrusted input that may carry instructions; a model completion is the same class of thing, and
the gate treats it the same way.

---

## 7. Package capture, end to end

The orchestration is designed and the reading half is blocked. Both facts are in the registry.

```
"photograph the box"
  -> start_package_capture   confirmed, because `16` treats a capture as a deliberate act:
                             pointing a lens at somebody's home on a misheard word is worth
                             one question, even though it writes nothing
  -> the camera opens, guided panel by panel:
       FRONT -> BACK -> INGREDIENTS -> BATCH_AND_EXPIRY
  -> capture_next_package_photo, once per panel
  -> [ extraction ]                                   ****  BLOCKED - BLK-007  ****
  -> read_extracted_fields   each field with its provenance and its confidence
  -> the person confirms each material field, one at a time
  -> confirm_extracted_item  which is the existing manual-entry write path, with confirmed
                             fields - nothing unconfirmed is written
```

**Nothing between the photographs and the confirmation exists**, and it is not stubbed. `17`
requires dual extraction - a conventional OCR engine **and** a structured multimodal model, with
deterministic validation and disagreement handling - and neither is credentialed (`BLK-007`,
`BLK-003`). A stub answering "nothing was read" would be indistinguishable, to a person and to a
test, from an extraction that ran and found nothing.

So `read_extracted_fields` and `confirm_extracted_item` are **listed and refused**, with the
blocker's identifier attached, and the agent says "that part of Kynviora is not finished yet". The
camera tools are not blocked: the photograph is real, and blocking it would lose the evidence.

---

## 8. What voice can do today, and what it cannot

**Today, with the shipped build:**

- Every gate, every refusal, the confirmation machine, the Speech Gate, the executor and the
  navigation bridge are real and exercised end to end - by a **deterministic scripted agent**, in
  CI, on a machine with no microphone.
- The Voice Mode screen is real and usable: a transcript, very large confirmation controls, the
  state said in a word and drawn in a shape, and a typed input that takes the identical path a
  spoken sentence would.

**What is not there:** speech recognition, a conversational model, and speech synthesis. All three
are `BLK-012`. Nothing listens and nothing speaks, and the screen says so rather than pretending.

**What the scripted agent establishes and does not.** It establishes that a proposal for tool X
with arguments Y is validated, confirmed, executed and reported correctly - including when the
proposal is hostile. It establishes **nothing** about whether a real model would propose that tool
for that sentence. That half is unmeasured because there is no provider, not because nobody looked.

---

## 9. What a provider decision needs

`BLK-012`. Three separate purchases, each of which would receive **health content spoken in
somebody's home**:

| Port                | What it would receive                                  | What it must promise                                                    |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `SpeechRecognizer`  | Audio of somebody naming their medicine                | Where the audio goes, whether it is retained, and by whom (`16` review) |
| `ConversationAgent` | A transcript and the tool list - **never record data** | That its output is treated as untrusted (`15`); no data-retention on it |
| `SpeechSynthesizer` | Text that has already passed the Speech Gate           | The same `16` review; it is a voice, not a writer                       |

`AgentTurnRequest` is deliberately small: what was said, the conversation as plain lines, and the
callable tools. **No session, no token, no profile contents, no identifiers.** A model that needed a
medicine's name to route a request would be a model being sent health content to do routing - and
routing does not need it, because resolving a spoken name to an item is itself a tool call.

Before any of them is wired: the model and data privacy review in `16`, and a recorded decision per
`23`. Picking one to make progress is exactly the fabrication the operating brief forbids.

---

## 10. Where things live

| Concern                                   | File                                      |
| ----------------------------------------- | ----------------------------------------- |
| Tool vocabulary, argument validation      | `packages/agent/src/tools.ts`             |
| The registry                              | `packages/agent/src/registry.ts`          |
| The six gates                             | `packages/agent/src/dispatcher.ts`        |
| Conversation and confirmation machine     | `packages/agent/src/session.ts`           |
| The Speech Gate and the closed utterances | `packages/agent/src/speech.ts`            |
| Confirmation summaries, refusal wording   | `packages/agent/src/summary.ts`           |
| Provider ports                            | `packages/agent/src/ports.ts`             |
| The deterministic fake, for CI            | `packages/agent/src/scriptedAgent.ts`     |
| The executor - the app's own client       | `apps/mobile/src/voice/executor.ts`       |
| The provider that holds it together       | `apps/mobile/src/voice/VoiceProvider.tsx` |
| The screen                                | `apps/mobile/src/voice/VoiceScreen.tsx`   |
| Where it is drawn, and the entry control  | `apps/mobile/src/voice/VoiceHost.tsx`     |

```bash
npm test -- packages/agent
```
