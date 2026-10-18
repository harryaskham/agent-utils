// Optional Pi host packages for tests that exercise the real SDK.
//
// Pi supplies @earendil-works/* to extensions at runtime, so they are peers, not
// dependencies. CI runs the suite as bare `node --test` without `npm install`;
// a test that needs the real host must skip there rather than fail, and must run
// whenever the packages are installed (e.g. after `npm install`).

export const HOST_NOT_INSTALLED = "Pi host packages not installed (bare node --test)";

// Import `specifier`, returning null only when that package itself is absent.
// Any other failure (a broken install, a throwing module) still fails the test.
export async function optionalHostModule(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes(`'${specifier}'`)) return null;
    throw error;
  }
}
