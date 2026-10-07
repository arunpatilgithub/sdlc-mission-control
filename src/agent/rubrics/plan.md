# Plan rubric

Judge the plan below. Cite a concrete location for every objection you raise — an
objection with no evidence is indistinguishable from a hallucination, and costs a
developer a revision loop for nothing.

1. **Do the named paths exist?** For every file or directory the plan says it will
   touch, confirm it is real in the current checkout. A plan built against a path
   that does not exist is a plan built against an imagined codebase.
2. **Is every acceptance criterion addressed or explicitly deferred?** Each criterion
   in the story must map to something the plan actually does, or the plan must say,
   under its own open questions, that it is deliberately leaving that criterion for
   the developer to decide. A criterion that silently disappears is a defect, not an
   oversight you should politely ignore.
3. **Is any external contract being assumed rather than confirmed?** Flag anywhere
   the plan guesses at a third-party field name, response shape, or schema instead of
   naming it as unconfirmed. A guessed contract that turns out wrong is far more
   expensive to discover after the diff lands than before it is written.
