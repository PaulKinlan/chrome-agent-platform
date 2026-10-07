// cap-a0-numeric-v1 — CAP-authored adapter for the A0 numeric fixture
// (chrome-agent-platform-ltkj.2 acceptance lane).
//
// Binds the single declared entry operation (weighted_sum) to the exact typed
// export `cap_weighted_sum` of the admitted main module. Parameters are
// range-checked against the manifest-declared f64 bounds before the call.
//
// Constraints (audited at admission; this file is shipped verbatim):
//   - ES module, no eval / Function constructor / dynamic code.
//   - No imports, no network, no DOM, no globals beyond the passed instance.
//   - The main module declares zero imports; no import object is constructed.

export const ADAPTER_ID = "cap-a0-numeric-v1";

const PARAM_MIN = -1000000;
const PARAM_MAX = 1000000;

function assertParam(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite f64 number`);
  }
  if (value < PARAM_MIN || value > PARAM_MAX) {
    throw new RangeError(`${name} outside declared bounds [${PARAM_MIN}, ${PARAM_MAX}]`);
  }
}

/**
 * Create the numeric operation surface for one admitted, instantiated module.
 * @param {{exports: Record<string, unknown>}} instance WebAssembly.Instance
 * @returns {{weightedSum: (value: number, weight: number, bias: number) => number}}
 */
export function createNumericAdapter(instance) {
  const fn = instance?.exports?.cap_weighted_sum;
  if (typeof fn !== "function") {
    throw new TypeError("cap_weighted_sum export missing or not a function");
  }
  return Object.freeze({
    weightedSum(value, weight, bias) {
      assertParam("value", value);
      assertParam("weight", weight);
      assertParam("bias", bias);
      return fn(value, weight, bias);
    },
  });
}
