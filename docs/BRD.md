# Business requirements

## Goals
1. More lost items get back to their owners.
2. Returns go to the real owner, not whoever asks first.
3. Less time spent by the admin office answering "was my item turned in" questions.

## Success metrics
Targets are assumptions for a first-semester pilot and should be revised with real data.

| Metric | Target | How measured |
|---|---|---|
| Found items claimed within 14 days | 50% | Items table, status released vs created |
| Lost posts matched by an "I found it" form | 25% | Challenge responses per lost post |
| Weekly active users | 500 | Supabase auth, distinct weekly sign-ins |
| Median time to log an item | Under 60 seconds | Timed pilot sessions |
| Wrong-person handovers | 0 | Staff reports |

## Stakeholders
- Decides: PUP admin office head, student council.
- Uses: students (finders and owners).
- Operates: admin office staff (custody, release), the project team (maintenance).

## Constraints
- Budget near zero. Must run on free or low tiers (Supabase, Gemini API).
- Must work on low-end phones and weak campus connectivity (PWA, offline queue).
- Personal data kept minimal. Sign-in collects name and email only; photo location data is stripped.
- Staff time is limited, so the flow must not add work for the office.

## Risks
| Risk | Mitigation |
|---|---|
| Low adoption, students keep using group chats | Launch with the office and student council, share links back into the same groups |
| False claims | Verification forms, claim limit of 3 per 24 hours, staff release at the office |
| Spam or abusive posts | Google sign-in required, authors can delete, staff can moderate |
| Storage fills up from photos | Re-encode and cap photos, move to object storage (see scale plan) |
| Office does not keep custody status up to date | Keep staff actions to one tap, notify owners automatically |

## Out of scope
- Direct messaging between strangers.
- Payments or rewards.
- Other campuses in this version.
