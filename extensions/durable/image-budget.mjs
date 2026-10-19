// pi-daemon Durable extension module: an image budget for model requests (bd-cf6146).
//
// List this file in a pi-daemon profile's `extensions:`. Before each request it keeps the
// newest images within a budget (PI_IMAGE_BUDGET_IMAGES, default 8; PI_IMAGE_BUDGET_MB,
// default 6) and replaces older ones with notes naming their files; after a provider 413/408
// the budget halves for the retry. The transcript keeps every image. It loads with nothing but
// Node built-ins.
import { createImageBudgetExtension } from "../lib/image-budget.js";

export const extension = createImageBudgetExtension();
