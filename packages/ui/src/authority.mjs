// Identity must be confirmed against this team's members before roles or capabilities can grant a write.
export function principalId(viewer, teamId = null) {
  if (typeof viewer === 'string') return viewer;
  if (!viewer || !teamId || viewer.teamId !== teamId) return null;
  return typeof viewer.memberId === 'string' && viewer.memberId.startsWith('member:') ? viewer.memberId : null;
}
function confirmedMember(data, viewer) {
  const id = principalId(viewer, data?.team?.teamId);
  const member = data?.members?.find(m => m.id === id);
  const denied = !id || id.startsWith('viewer:') || ['viewer', 'unknown'].includes(data?.viewerRole) ||
    ['viewer', 'unknown'].includes(member?.role) || (viewer !== 'operator' && !member);
  return { id, member, denied };
}
export function viewerReadOnly(data, viewer) {
  const { id, member, denied } = confirmedMember(data, viewer);
  if (denied) return true;
  if (id === 'operator') return false;
  return member.role !== 'root' || (data?.viewerRole != null && !['root', 'operator'].includes(data.viewerRole));
}
export function commandObject(data, target) {
  for (const key of ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'resourceThreads']) {
    const found = data?.[key]?.find(row => row.id === target);
    if (found) return found;
  }
  return data?.members?.map(m => m.attempt).find(a => a?.id === target) ?? null;
}
export function commandAdmission(cmd, data, viewer, generation = null) {
  if (!cmd) return '没有可执行的命令';
  const { id, denied } = confirmedMember(data, viewer);
  if (denied) {
    return '只读查看：未确认写入身份，操作由 operator / root 处理';
  }
  if (cmd.principal !== undefined && cmd.principal !== id) return '身份已变化，请重新打开操作';
  if (cmd.scopeGeneration != null && cmd.scopeGeneration !== generation) return '团队会话已切换，请重新打开操作';
  const row = commandObject(data, cmd.target);
  if (row?.capabilities != null) {
    const cap = row.capabilities[cmd.name];
    if (cap?.allowed !== true) return cap?.reasonText ?? '服务端没有授予此操作权限';
  }
  return null;
}
