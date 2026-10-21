const clamp=(value,min,max,fallback)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
export const FREQUENCIES=Object.freeze({less:0.86,standard:0.7,more:0.55});
export const STRICTNESS=Object.freeze({inclusive:{worth:0.4,significance:0},balanced:{worth:0.5,significance:0.5},strict:{worth:0.75,significance:2.4}});
export function normalizeOutputPolicy(value={}) {
  const frequency=Object.hasOwn(FREQUENCIES,value.frequency)?value.frequency:'standard';
  const strictness=Object.hasOwn(STRICTNESS,value.strictness)?value.strictness:'balanced';
  return {frequency,strictness,novelty:clamp(value.novelty,0.5,0.95,FREQUENCIES[frequency]),
    worth:clamp(value.worth,0.3,0.95,STRICTNESS[strictness].worth),
    significance:clamp(value.significance,0,4,STRICTNESS[strictness].significance)};
}
