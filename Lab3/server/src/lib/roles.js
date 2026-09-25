'use strict';

/**
 * Ролевая модель доступа (RBAC). Роль хранится у пользователя в БД,
 * а набор прав выводится из роли здесь — в одном месте.
 *
 * Права на задачи бывают двух уровней:
 *   :own — только на свои задачи (owner_id = id пользователя);
 *   :any — на задачи всех пользователей.
 */
const PERMISSIONS = {
  TASKS_READ_OWN: 'tasks:read:own',
  TASKS_READ_ANY: 'tasks:read:any',
  TASKS_CREATE: 'tasks:create',
  TASKS_UPDATE_OWN: 'tasks:update:own',
  TASKS_UPDATE_ANY: 'tasks:update:any',
  TASKS_DELETE_OWN: 'tasks:delete:own',
  TASKS_DELETE_ANY: 'tasks:delete:any',
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage'
};

const P = PERMISSIONS;

const USER_PERMISSIONS = [P.TASKS_READ_OWN, P.TASKS_CREATE, P.TASKS_UPDATE_OWN, P.TASKS_DELETE_OWN];

const ROLES = [
  {
    value: 'user',
    label: 'Пользователь',
    description: 'Создаёт задачи и управляет только своими задачами',
    permissions: USER_PERMISSIONS
  },
  {
    value: 'manager',
    label: 'Менеджер',
    description: 'Видит и редактирует задачи всех пользователей, удаляет только свои',
    permissions: [...USER_PERMISSIONS, P.TASKS_READ_ANY, P.TASKS_UPDATE_ANY, P.USERS_READ]
  },
  {
    value: 'admin',
    label: 'Администратор',
    description: 'Полный доступ к задачам, управление пользователями, ролями и сессиями',
    permissions: Object.values(P)
  }
];

const ROLE_VALUES = ROLES.map((role) => role.value);
const DEFAULT_ROLE = 'user';
const ROLE_PERMISSIONS = Object.fromEntries(ROLES.map((role) => [role.value, new Set(role.permissions)]));

function isValidRole(value) {
  return ROLE_VALUES.includes(value);
}

function permissionsOf(role) {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

function hasPermission(user, permission) {
  return Boolean(user && ROLE_PERMISSIONS[user.role] && ROLE_PERMISSIONS[user.role].has(permission));
}

/**
 * Право на действие с конкретной задачей: либо «:any», либо «:own» и задача своя.
 * action — read | update | delete.
 */
function canOnTask(user, action, task) {
  if (hasPermission(user, `tasks:${action}:any`)) return true;
  return hasPermission(user, `tasks:${action}:own`) && task.ownerId === user.id;
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_VALUES,
  DEFAULT_ROLE,
  isValidRole,
  permissionsOf,
  hasPermission,
  canOnTask
};
