/** Browser-only authenticated HTTP transport and command gateway, no store imports; 08 §1.2, §5. */
export function createTransport(base, token) {
  const read = async (path, init = {}) => {
    const response = await fetch(base + path, { ...init, headers: { authorization: 'Bearer ' + token, ...init.headers } });
    if (!response.ok) {
      const text = await response.text();
      let details = null; try { details = JSON.parse(text); } catch { /* retain original body in the error */ }
      throw Object.assign(Error('projection HTTP ' + response.status + (details?.error ? ': ' + details.error : '')), {
        status: response.status, code: details?.error ?? null, details, body: text,
      });
    }
    return response;
  };
  const gateway = { submit: async command => (await read('/team/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })).json() };
  return { read, gateway };
}
