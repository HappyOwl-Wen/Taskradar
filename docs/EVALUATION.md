# Evaluation

All numbers in this document were produced by running the commands shown here; nothing is estimated.
The datasets are small and synthetic, so the results describe behaviour on these cases, not on real mailboxes.

## What is measured

`python -m taskradar eval` runs the offline rule engine (`RuleBasedExtractor`, no network, no LLM) and the
reconciler over hand-labelled cases, in order, as if they arrived one after another.

Each case is a synthetic message (subject, body, optional send date, labels, bulk flag) with

* the expected tasks — a group ID (the real-world obligation), the action type, the deadline date and time if any,
  and keywords;
* optionally an expected completion signal (explicit or hedged, and which obligation it completes).

Definitions:

| Metric | Definition |
| --- | --- |
| Task precision / recall / F1 | A predicted task matches an expected one if at least two of three agree: a keyword appears in the title, action or evidence; the action type is compatible; the deadline date is equal. Computed over task mentions. |
| Deadline date / time correct | For matched tasks with an expected deadline: same date; same clock time, where "no time" must stay empty (no invented 23:59). |
| "No deadline" kept empty | Matched tasks whose source states no deadline must not get one. |
| Marketing/info cases with false tasks | Cases that contain no obligation (newsletters, ads, FYI, status updates); counts cases where any task was produced. |
| Correct / wrong / missed merges | Each prediction is reconciled against the tasks created by earlier cases. Merging into the same obligation is correct, into another obligation is wrong; creating a new task although the obligation existed is missed; a grey-zone suggestion is counted as "flagged". |
| Completion evidence | The completion signal is detected, classified correctly as explicit or hedged, and matched to the right existing task. |
| Processing time | Wall-clock time of the extractor per case (text only — OCR is measured separately below). |

## Datasets

| | Development set | Held-out set |
| --- | --- | --- |
| File | `backend/src/taskradar/demo/eval_dataset.json` | `backend/src/taskradar/demo/eval_holdout.json` |
| Cases (zh / de / en) | 36 (12 / 12 / 12) | 30 (10 / 10 / 10) |
| Cases with obligations / expected task mentions | 23 / 24 | 18 / 18 |
| Cases without obligations | 7 | 7 |
| Completion cases | 6 | 5 |
| Use | written and used while developing the rules | written separately; not used for tuning |

## Results (`rules-1.5`)

```powershell
cd backend
.venv\Scripts\python.exe -m taskradar eval
.venv\Scripts\python.exe -m taskradar eval --dataset src\taskradar\demo\eval_holdout.json
```

| Metric | Development set | Held-out set |
| --- | --- | --- |
| Precision / recall / F1 | 1.00 / 1.00 / 1.00 (TP 24, predicted 24, expected 24) | 1.00 / 0.78 / 0.88 (TP 14, predicted 14, expected 18) |
| Deadline date correct | 21/21 | 13/13 |
| Deadline time correct | 21/21 | 12/13 |
| "No deadline" kept empty | 3/3 | 1/1 (see history) |
| Marketing/info cases with false tasks | 0/7 | 0/7 |
| Merges correct / wrong / missed / flagged | 5/5 / 0 / 0 / 0 | 1/1 / 0 / 0 / 0 |
| Completion detected / explicit-vs-hedged correct / right task | 6/6 / 6/6 / 4/4 | 3/5 / 3/5 / 0/2 |
| Extractor time per case (Windows 11, Ryzen 9 7940H, three runs) | 1.1 – 1.2 ms | 1.1 ms |

The development numbers show that the rules handle the phrasings they were built for; they are not evidence of
generalisation. The held-out numbers are the honest estimate. One held-out case (h-en-01) became correct
with `rules-1.4` after its failure had been analysed (see History); without it, `rules-1.3` and `rules-1.4`
score the same on the held-out set: precision 1.00, recall 0.76 (TP 13 of 17).

### Held-out failures (analysis)

| Case | Problem | Cause (traced with the reconciler's reasons) |
| --- | --- | --- |
| h-zh-06 | Completion detected but not linked to the visa task | The evidence is the subject line "材料已收到", which does not mention the visa (similarity 0.23) |
| h-de-07 | Completion detected but not linked to the rental-contract task | The original request was titled from a pronoun sentence ("Diese hochladen"), so the confirmation about the "Kopie des Mietvertrags" scored 0.50, below the 0.55 completion threshold |
| h-zh-08 | Time missing ("下午两点") | Clock times written with Chinese numerals are not parsed |
| h-zh-09 | Missed "请及时归还或续借" (library loan) | 归还 / 续借 are not in the action lexicon |
| h-de-05 | Missed "Bitte holen Sie es … ab" (parcel) | The separable verb abholen is not in the action lexicon |
| h-de-06 | Missed "Ihre Kopie des Mietvertrags fehlt noch. Frist: 25.10.2026." | A reminder that states what is missing instead of what to do |
| h-en-04 | Missed "oral exam slots must be booked by October 22" | The passive "must be booked" is not covered |
| h-en-05, h-en-10 | Completion not detected | "has been confirmed" and "was submitted successfully" are not in the completion lexicon |

Two weaknesses are not visible in the scores: task titles built from pronoun sentences ("Diese hochladen") or
from a follow-up sentence (h-en-01: "Pay arrives" for *"make sure the transfer arrives on time"*) are counted
as correct when action and date match, and completion matching depends on the confirmation naming the same
object as the request.

These are typical recall limits of hand-written rules; they motivate the optional LLM extractor, whose quality
has **not** been measured yet (no API key was available while building this project).

## History

* **rules-1.2 → rules-1.3.** The first held-out run (rules-1.2) produced identical numbers except "no deadline kept
  empty" 0/1: for *"innerhalb von 14 Tagen nach Vertragsunterzeichnung"* (h-de-08) a date was computed from the mail
  date although the period starts at an unknown event. Periods anchored to unknown events are now left unresolved
  and flagged for review. Because the fix was made after seeing this case, h-de-08 is no longer an independent test.
* **2026-10-14, reconciliation.** During the end-to-end UI test, the demo mailbox produced a false
  "possible duplicate" suggestion between a German exam registration and a Chinese course registration that only
  shared the platform name "TUMonline". Platform and channel names no longer count as object evidence. Both
  evaluation sets gave identical results before and after; a regression test was added
  (`test_shared_platform_name_does_not_make_tasks_duplicates`).
* **rules-1.3 → rules-1.4 (2026-10-14, real mailbox).** On a real mailbox, 10 of the open tasks had no
  deadline. A local check that printed only counts and masked line layouts (no mail text was copied into this
  project) found that 9 of these mails state no deadline at all; the tenth was a payment reminder whose due date
  was a header line ("Due date: …") *above* the
  instruction, separated by a status line. The rules only looked for such deadline lines *after* an
  instruction. Now a preceding line with a deadline cue (up to three segments back) is used as well, unless
  an earlier instruction lies in between or the line directly follows an earlier instruction (then it
  belongs to that one); a status line with a verb but no obligation cue no longer counts as an instruction.
  New cue words: *Fälligkeit(sdatum)*, *Zahlungsziel*, *Zahlungsfrist*, *到期日*. Regression tests were
  added for English, German and Chinese headers, an ambiguous slash date and two negative cases
  (`test_deadline_line_above_the_instruction` and the two tests after it). The development set is
  unchanged. On the held-out set, h-en-01 ("your rent … is due on November 1st. Please make sure the
  transfer arrives on time.") now gets the right date from the preceding sentence. That case's failure
  had been analysed before, so this gain is not an independent measurement (see above).
* **rules-1.4 → rules-1.5 (2026-10-15, real mailbox).** Candidate titles such as "Reply above this line",
  "Nicht antworten" and "Register for only" came from ticket-system footers, "do not reply" notices and an
  advert. Template lines (ticket separators, "this e-mail was sent automatically" and the German and Chinese
  equivalents) and instructions negated in the same clause ("Bitte nicht antworten", "Please do not reply",
  "请勿回复"; but not "don't forget to …" / "Vergessen Sie nicht, … zu …") no longer become tasks; price
  offers ("for only €49", "save 30%") count as marketing; titles that stop mid-phrase are flagged for review
  ("content needs checking") while the full sentence is kept. Regression tests:
  `test_mail_templates_and_negated_instructions_are_not_tasks` and the three tests after it. Both evaluation
  sets give identical results; the extractor time per case rose from about 0.7 to 1.1 ms.

## End-to-end performance

Measured with the real pipeline (file type detection, PDF text extraction or Tesseract OCR, extraction,
reconciliation, database writes) by importing the seven sample documents in
`backend/src/taskradar/demo/samples/` three times into fresh databases.
Machine: AMD Ryzen 9 7940H, 31 GB RAM, Windows 11, Tesseract 5.4.0, rule engine.

| File | Method | Result | Median of 3 (runs) |
| --- | --- | --- | --- |
| 01_zh_enrollment_certificate_notice.pdf | text | 1 task | 97 ms (102 / 90 / 97) |
| 02_de_residence_permit_documents.png | OCR | 1 task | 645 ms (650 / 637 / 645) |
| 03_de_residence_permit_reminder.png | OCR | merged into the existing task | 538 ms (508 / 540 / 538) |
| 04_zh_enrollment_certificate_reminder.png | OCR | merged into the existing task | 988 ms (955 / 988 / 1006) |
| 05_zh_course_registration_scan.pdf | OCR (image-only PDF) | 1 task | 1188 ms (1158 / 1188 / 1323) |
| 06_en_rental_contract.pdf | text | 1 task | 45 ms (39 / 48 / 45) |
| 07_de_marketing.png | OCR | no task (marketing) | 396 ms (383 / 396 / 457) |
| **All seven** | | 4 tasks, 2 merges | 3.8 s / 3.9 s / 4.1 s |

## Not measured yet

* Extraction quality and cost with a real LLM (OpenAI or a local OpenAI-compatible model).
* Behaviour on real Gmail mailboxes (requires the user's own OAuth authorization).
* OCR on photos taken with a phone, handwriting, or languages other than Chinese, German and English.
