(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let material = null;
  let generating = false;
  let backedUp = false;

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], {type}));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function copy(text, fallbackId) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      $('copy-status').textContent = 'Скопировано. Вставьте в поле Secret на GitHub.';
    } catch (_) {
      const field = $(fallbackId);
      field.closest('details').open = true;
      field.focus();
      field.select();
      $('copy-status').textContent = 'Выделите и скопируйте значение вручную, затем вставьте на GitHub.';
    }
  }

  function showMaterial(value, restored) {
    material = value;
    $('key-text').value = bytesToBase64(material.keystore);
    $('password-text').value = material.password;
    $('fingerprint').textContent = material.fingerprint;
    $('result').hidden = false;
    $('generate').disabled = true;
    $('restore').disabled = true;
    $('restore-section').open = false;
    $('generate').textContent = restored ? 'Ключ восстановлен' : 'Ключ создан';
    $('status').textContent = 'Готово. Сохраните файлы и добавьте оба секрета ниже.';
    if (restored) backedUp = true;
  }

  $('generate').addEventListener('click', async () => {
    if (material || generating) return;
    if (!window.confirm('Создать новый ключ? Если вы уже создавали его раньше, выберите восстановление из сохранённых файлов.')) return;
    generating = true;
    $('generate').disabled = true;
    $('restore').disabled = true;
    $('status').textContent = 'Создаём ключ на устройстве. Пожалуйста, подождите…';
    try {
      showMaterial(await OpenStreetKeygen.generate(globalThis.crypto, globalThis.forge), false);
    } catch (error) {
      $('status').textContent = error && error.message ? error.message : 'Не удалось создать ключ. Попробуйте другой браузер.';
      $('generate').disabled = false;
      $('restore').disabled = false;
    } finally {
      generating = false;
    }
  });

  $('restore').addEventListener('click', async () => {
    if (material || generating) return;
    const keyFile = $('restore-key').files[0];
    const passwordFile = $('restore-password').files[0];
    if (!keyFile || !passwordFile || keyFile.size > 30000 || passwordFile.size > 4096) {
      $('status').textContent = 'Выберите оба сохранённых файла: ключ .p12 и пароль .txt.';
      return;
    }
    generating = true;
    $('generate').disabled = true;
    $('restore').disabled = true;
    $('status').textContent = 'Проверяем файлы на устройстве…';
    try {
      const bytes = new Uint8Array(await keyFile.arrayBuffer());
      const password = (await passwordFile.text()).replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
      showMaterial(await OpenStreetKeygen.restore(globalThis.crypto, globalThis.forge, bytes, password), true);
    } catch (error) {
      $('status').textContent = error && error.message ? error.message : 'Не удалось прочитать файлы ключа.';
      $('generate').disabled = false;
      $('restore').disabled = false;
    } finally {
      generating = false;
    }
  });

  let keyDownloaded = false;
  let passwordDownloaded = false;
  $('download-key').addEventListener('click', () => {
    if (!material) return;
    download('OpenStreet-new-signing-key.p12', material.keystore, 'application/x-pkcs12');
    keyDownloaded = true;
    backedUp = keyDownloaded && passwordDownloaded;
  });
  $('download-password').addEventListener('click', () => {
    if (!material) return;
    download('OpenStreet-new-signing-password.txt', material.password, 'text/plain;charset=utf-8');
    passwordDownloaded = true;
    backedUp = keyDownloaded && passwordDownloaded;
  });
  $('copy-key').addEventListener('click', () => material && copy($('key-text').value, 'key-text'));
  $('copy-password').addEventListener('click', () => material && copy(material.password, 'password-text'));

  window.addEventListener('beforeunload', event => {
    if (!material || backedUp) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
