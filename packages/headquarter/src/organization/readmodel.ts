/** Pure derived read models over an OrgState — org chart tree and vacancies. */

import type { Department, OrgChartNode, OrgState, VacancyReport } from './types.js';

export function buildOrgChart(state: OrgState): OrgChartNode[] {
  const childrenByParent = new Map<string | null, Department[]>();
  for (const d of Object.values(state.departments)) {
    const key = d.parentDepartmentId;
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(d);
    else childrenByParent.set(key, [d]);
  }
  const rolesByDept = new Map<string, string[]>();
  for (const r of Object.values(state.roles)) {
    const bucket = rolesByDept.get(r.departmentId);
    if (bucket) bucket.push(r.id);
    else rolesByDept.set(r.departmentId, [r.id]);
  }
  const occupantCountByRole = new Map<string, number>();
  for (const o of Object.values(state.occupants)) {
    occupantCountByRole.set(o.roleId, (occupantCountByRole.get(o.roleId) ?? 0) + 1);
  }

  function buildNode(dept: Department, visited: ReadonlySet<string>): OrgChartNode {
    // Defense in depth: defineDepartment can never itself construct a cycle
    // (a parent must already exist before a child references it, and there
    // is no department-parent mutation op), but guard traversal anyway.
    if (visited.has(dept.id)) {
      return { department: dept, children: [], roles: [] };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(dept.id);
    const roles = (rolesByDept.get(dept.id) ?? []).map((roleId) => {
      const role = state.roles[roleId];
      const occ = occupantCountByRole.get(roleId) ?? 0;
      return {
        role,
        occupants: Object.values(state.occupants).filter((o) => o.roleId === roleId),
        vacancies: Math.max(0, role.teamSizeTarget - occ),
      };
    });
    const children = (childrenByParent.get(dept.id) ?? []).map((child) => buildNode(child, nextVisited));
    return { department: dept, children, roles };
  }

  return (childrenByParent.get(null) ?? []).map((d) => buildNode(d, new Set()));
}

export function buildVacancyReport(state: OrgState): VacancyReport[] {
  const counts = new Map<string, number>();
  for (const o of Object.values(state.occupants)) {
    counts.set(o.roleId, (counts.get(o.roleId) ?? 0) + 1);
  }
  return Object.values(state.roles).map((role) => {
    const current = counts.get(role.id) ?? 0;
    return {
      roleId: role.id,
      roleName: role.name,
      teamSizeTarget: role.teamSizeTarget,
      currentOccupants: current,
      vacant: Math.max(0, role.teamSizeTarget - current),
    };
  });
}

export function rolesForWorker(state: OrgState, workerId: string): string[] {
  return Object.values(state.occupants)
    .filter((o) => o.workerId === workerId)
    .map((o) => o.roleId);
}
