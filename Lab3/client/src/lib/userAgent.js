// Короткое человекочитаемое описание устройства по User-Agent — для списка сессий.
export function describeUserAgent(ua = '') {
  if (!ua) return 'Неизвестное устройство';
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\//.test(ua) && 'Opera') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    (/curl\//.test(ua) && 'curl') ||
    (/PostmanRuntime/.test(ua) && 'Postman') ||
    'Браузер';
  const os =
    (/Windows/.test(ua) && 'Windows') ||
    (/Android/.test(ua) && 'Android') ||
    (/(iPhone|iPad)/.test(ua) && 'iOS') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    '';
  return os ? `${browser} · ${os}` : browser;
}
