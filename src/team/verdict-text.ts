// The closing instructions every step gets, whatever its role: the verdict shape and what each outcome means. One text, shared by the five built-in phases and by roles from the roster.
export const VERDICT_INSTRUCTIONS = `
When you are done, end your final message with a fenced json block, and nothing after it, in exactly this shape:

\`\`\`json
{
  "completed": true,
  "outcome": "pass",
  "headline": "one sentence, what you did or why you stopped",
  "details": "a short paragraph: what you did, what you found, what you produced",
  "concerns": ["short bullet", "short bullet"],
  "blockingFindings": []
}
\`\`\`

"completed" is whether you finished acting at all (false only if you couldn't do your job — crashed, ran out of
time, or were blocked before you could even start). It is NOT whether the result is good.

"outcome" is your actual judgment and must be exactly one of:
  - "pass": you did your job and found nothing that should block this run from proceeding.
  - "fail": you found a genuine defect in what you reviewed or produced (a failing test, a real bug, a security
    issue, a plan that doesn't match the task). Put every specific defect in "blockingFindings", not just
    "concerns" — concerns are for things worth noting that don't need to block anything.
  - "blocked": you cannot proceed for a reason no retry of your own work can fix — the task is ambiguous or
    contradictory, or a decision only a human can make is needed. Say exactly what's needed in "blockingFindings".
  - "inconclusive": you genuinely could not determine pass or fail (couldn't run the tests, couldn't reach a
    dependency). Never report "pass" when you're actually unsure — say "inconclusive" and explain why in details.

Do not report "pass" just because you finished your turn. A completed review that found a real bug is
"outcome": "fail", not "pass" — reporting a real problem clearly is your job succeeding at reporting, not grounds
to call the outcome itself good.
`;
