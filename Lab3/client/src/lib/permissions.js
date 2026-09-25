// Зеркало серверной ролевой модели — только чтобы прятать недоступные кнопки.
// Решение о доступе всё равно принимает сервер (403/404).
export const can = (user, permission) => Boolean(user && user.permissions.includes(permission));

export function canOnTask(user, action, task) {
  if (can(user, `tasks:${action}:any`)) return true;
  return can(user, `tasks:${action}:own`) && task.ownerId === user.id;
}
