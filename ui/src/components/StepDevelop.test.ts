import { describe, expect, it } from "vitest";
import { firstExecutableRepository } from "./StepDevelop";

describe("firstExecutableRepository", () => {
  it("skips an approved no-change repository when selecting the initial Develop boundary", () => {
    expect(firstExecutableRepository([
      "Publisher.MicroService.PostbackHandler",
      "Publisher.Portal",
      "publisher.documentation",
      "Publisher.MicroService.PixelHandler",
    ], {
      "Publisher.MicroService.PixelHandler": [],
      "Publisher.MicroService.PostbackHandler": ["src/PixelTypes.js"],
      "Publisher.Portal": ["src/components/Campaigns/Detail/Pixels.js"],
      "publisher.documentation": ["docs/external/Integration/Features/Pixels-and-Postbacks/index.md"],
    })).toBe("Publisher.MicroService.PostbackHandler");
  });
});
