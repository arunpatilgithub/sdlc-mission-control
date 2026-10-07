# Diff rubric

Judge the diff below. Cite a concrete location for every objection you raise — an
objection with no evidence is indistinguishable from a hallucination, and costs a
developer a revision loop for nothing.

1. **Does the diff implement the plan?** Compare what actually changed against what
   the plan said would change. A diff that drifts from its own plan without
   explanation is a defect, not a judgment call the developer should have to untangle.
2. **Were tests weakened or deleted to make the suite pass?** A loosened assertion, a
   skipped case, or a deleted test that used to catch a real failure is worse than a
   red build, because it hides the failure instead of reporting it honestly.
3. **Was anything invented where the prompt required a `TODO(mission-N)` marker?** An
   unconfirmed detail must be marked, not guessed at. A fabricated value standing in
   for a real unknown is exactly the failure mode that marker exists to prevent.
