// pi-daemon Durable extension module: images in model requests. It changes no request (bd-e7946b).
//
// An image stays in every request until the conversation is compacted, as in TUI Pi, whatever
// the model's limits. A request the provider refuses for its size (HTTP 413) is a context
// overflow to Durable, which compacts the conversation once and sends it again. A request
// refused for another limit (more images than the model takes) fails. Images are made smaller
// as they are read, by the host (pi-daemon gives Durable's `read` an image processor, which
// fits each image to the model's `inputLimits.images.resize`).
//
// This module used to turn images into notes at a limit (bd-cf6146, bd-968865, bd-dd9e44).
// Any such change rewrites the prompt cache of a model that reads only whole earlier requests
// from it (Claude): on 24 Nov 2026 a session rewrote 233k tokens at every image it read. So
// nothing is left out any more, and PI_IMAGE_BUDGET_IMAGES, PI_IMAGE_BUDGET_MB and their
// _DEFAULT_ forms are no longer read. The module stays so that a profile that lists it loads.
export const extension = { name: "agent-utils-image-budget", hooks: [] };
