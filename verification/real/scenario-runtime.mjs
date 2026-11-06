/** Shared wait helper for the scenario and its split-out runtime methods. */
export const until=async(predicate,what,timeoutMs=120000)=>{const end=Date.now()+timeoutMs;for(;;){const value=predicate();if(value)return value;if(Date
      .now()>end)throw Error('TIMEOUT: '+what);await new Promise(resolve=>setTimeout(resolve,10))}};
