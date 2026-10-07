import { describe, expect, it } from "vitest";
import { parseAggregateReview } from "./aggregate-review.js";

describe("parseAggregateReview", () => {
  it("accepts repository-qualified objections", () => {
    const output = '```json\n{"disposition":"revise","affectedRepositories":["Ui"],"objections":[{"claim":"UI consumes the old field","evidence":["Api:src/api.ts","Ui:src/ui.ts"],"repositories":["Api","Ui"]}]}\n```';

    expect(parseAggregateReview(output, ["Api", "Ui"])).toEqual({
      disposition: "revise",
      affectedRepositories: ["Ui"],
      objections: [{
        claim: "UI consumes the old field",
        evidence: ["Api:src/api.ts", "Ui:src/ui.ts"],
        repositories: ["Api", "Ui"],
      }],
      parseError: null,
    });
  });

  it("degrades an unqualified revision instead of reopening arbitrary repositories", () => {
    const output = '```json\n{"disposition":"revise","affectedRepositories":["Unselected"],"objections":[]}\n```';
    const parsed = parseAggregateReview(output, ["Api", "Ui"]);

    expect(parsed.disposition).toBe("not-detected");
    expect(parsed.affectedRepositories).toEqual([]);
    expect(parsed.parseError).toMatch(/identify at least one/);
  });
});
