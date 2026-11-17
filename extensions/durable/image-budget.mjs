// pi-daemon Durable extension module: images in model requests (bd-cf6146, bd-968865).
//
// List this file in a pi-daemon profile's `extensions:`. Images stay in every request until
// the conversation is compacted, as in TUI Pi. They leave earlier only for a limit of the
// provider's (the model's declared inputLimits.maxRequestBytes and images.maxPerRequest, or a
// request it refused for its size) or the operator's (PI_IMAGE_BUDGET_IMAGES,
// PI_IMAGE_BUDGET_MB; unset by default): the oldest become notes naming their files, down to
// half of the limit, in one step. The transcript keeps every image. It loads with nothing but
// Node built-ins.
import { createImageBudgetExtension } from "../lib/image-budget.js";

export const extension = createImageBudgetExtension();
