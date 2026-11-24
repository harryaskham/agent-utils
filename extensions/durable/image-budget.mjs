// pi-daemon Durable extension module: images in model requests (bd-cf6146, bd-968865, bd-dd9e44).
//
// List this file in a pi-daemon profile's `extensions:`. Images stay in every request until
// the conversation is compacted, as in TUI Pi. They leave earlier only for a limit of the
// provider's (the model's declared inputLimits.maxRequestBytes and images.maxPerRequest, or a
// request it refused for its size) or the operator's (PI_IMAGE_BUDGET_IMAGES,
// PI_IMAGE_BUDGET_MB; unset by default): the newest images the model has already answered
// become notes naming their files, so the request changes only near its end (bd-dd9e44). The
// limits are those of the model the request goes to. The transcript keeps every image. It
// loads with nothing but Node built-ins.
import { createImageBudgetExtension } from "../lib/image-budget.js";

export const extension = createImageBudgetExtension();
