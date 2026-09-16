export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function ensure(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export function text(value: unknown, name: string, max = 1000): string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', name + '不能为空或过长', 400);
  return value.trim();
}
export function integer(value: unknown, name: string, min = 0, max = 10000000): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', name + '格式错误', 400);
  return value;
}
