import { describe, expect, it } from "vitest";
import { repositoryOptionLabel } from "./StepStoryAndRepo";

describe("repositoryOptionLabel", () => {
  it("identifies configured GitLab repositories in the selector", () => {
    expect(repositoryOptionLabel({ id: "documentcrud", scm: "gitlab", integrationBranch: "main" }))
      .toBe("GitLab · main");
  });

  it("retains Azure DevOps identification", () => {
    expect(repositoryOptionLabel({ id: "Publisher.Portal", scm: "azure-devops", integrationBranch: "releases" }))
      .toBe("Azure DevOps · releases");
  });
});
