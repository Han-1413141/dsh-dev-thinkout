import {apply as applyHost} from './host.js';
export {name,version,inject} from './host.js';
/** The same plugin with the bottom progress hidden for new sessions. */
export function apply(ctx,config={}) {
  return applyHost(ctx,{...config,showStatusBar:config.showStatusBar??false});
}
