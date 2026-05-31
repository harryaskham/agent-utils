// Describe-parameter tool schemas for the kitty image preview, extracted from
// kitty-image-preview.js (bd-e1914a). Pure typebox builders.

import { Type } from "@sinclair/typebox";
import { DEFAULT_DESCRIBE_MODEL } from "./constants.js";

export function describeParameterSchema() {
  return {
    describe: Type.Optional(Type.Boolean({ description: "Send this still image to a vision model and include an objective visual description in the tool result. Defaults to false." })),
    describeModel: Type.Optional(Type.String({ description: `Vision model as provider/model. Defaults to KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL or ${DEFAULT_DESCRIBE_MODEL}.` })),
    describePrompt: Type.Optional(Type.String({ description: "Optional extra instruction appended to the default objective image-description prompt." })),
    describeMaxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens for image description. Defaults to 1200." })),
  };
}

export function streamDescribeParameterSchema() {
  return {
    describe: Type.Optional(Type.Boolean({ description: "Describe the first stream frame with a vision model. Defaults to false unless describeIntervalSecs is set." })),
    describeIntervalSecs: Type.Optional(Type.Number({ description: "If set, describe the first stream frame and then the next completed frame after each interval. Descriptions are status metadata only, not image attachments." })),
    describeModel: Type.Optional(Type.String({ description: `Vision model as provider/model. Defaults to KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL or ${DEFAULT_DESCRIBE_MODEL}.` })),
    describePrompt: Type.Optional(Type.String({ description: "Optional extra instruction appended to the default objective image-description prompt." })),
    describeMaxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens for stream frame descriptions. Defaults to 1200." })),
  };
}
