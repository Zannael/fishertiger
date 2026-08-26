/** Numbers the async requests that write shared state, so only the newest one
 *  may commit. */
export const createRequestGate = () => {
  let current = 0;
  return {
    claim: () => ++current,
    latest: () => current,
    isCurrent: (request) => request === current,
  };
};
