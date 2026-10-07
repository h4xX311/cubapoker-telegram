/**
 * COMPRUEBA QUE EL BOT TENGA EL BOTON DEL MENU CONFIGURADO.
 *
 * El sintoma es "Sesion expirada / solo funciona dentro de Telegram" AUQUE se abre desde
 * Telegram. Eso significa que `window.Telegram.WebApp.initData` llega VACIO.
 *
 * Y hay una razon muy concreta: si el Mini App se abre con un enlace normal, o con una URL
 * puesta a mano en los ajustes, Telegram abre la pagina en su navegador interno SIN pasarle
 * `initData`. Sin `initData` no hay forma de saber quien es el jugador, asi que la
 * aplicacion lo rechaza. Y hace bien: permitirlo seria permitir que cualquiera se pase por
 * otro.
 *
 * Con el boton del menu (`/setmenubutton`), Telegram abre la Web App CON `initData`.
 *
 * Esto solo LEE. No cambia nada del bot.
 */
require('dotenv').config();

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('TELEGRAM_BOT_TOKEN vacio en el .env: no se puede comprobar.');
    process.exit(1);
  }

  const api = (metodo) => fetch(`https://api.telegram.org/bot${token}/${metodo}`).then((r) => r.json());

  // 1. Quien es el bot
  const me = await api('getMe');
  if (!me.ok) {
    console.log('El token no vale:', me.description);
    process.exit(1);
  }
  console.log(`Bot: @${me.result.username} (${me.result.first_name})`);

  // 2. Tiene boton de menu?
  const menu = await api('getChatMenuButton');
  if (!menu.ok) {
    console.log('No se pudo leer el boton:', menu.description);
  } else if (!menu.result || menu.result.type === 'default') {
    console.log('');
    console.log('*** NO HAY BOTON DE MENU ***');
    console.log('  type: "default" = el bot no tiene ningun boton.');
    console.log('  Eso significa que no hay forma de abrir la Web App con initData.');
  } else {
    console.log('');
    console.log('Boton de menu configurado:');
    console.log(`  type: ${menu.result.type}`);
    const t = menu.result.web_app;
    if (t) {
      console.log(`  texto:   "${t.text}"`);
      console.log(`  url:     ${t.url}`);
      if (t.url.endsWith('/')) {
        console.log('  AVISO: la URL termina en "/". Telegram a veces no pasa initData con ella.');
        console.log('          Quitala: debe ser https://TU-SERVICIO.onrender.com');
      }
    }
  }

  // 3. Webhook registrado?
  const hook = await api('getWebhookInfo');
  if (hook.ok) {
    console.log('');
    console.log('Webhook:');
    console.log(`  url: ${hook.result.url || '(sin registrar)'}`);
    console.log(`  pendientes: ${hook.result.pending_update_count}`);
    if (hook.result.last_error_message) {
      console.log(`  ultimo error: ${hook.result.last_error_message}`);
    }
  }

  console.log('');
  console.log('--- QUE HACER SI NO HAY BOTON ---');
  console.log('  @BotFather -> /setmenubutton -> elige el bot ->');
  console.log('  texto: "Jugar"');
  console.log('  URL:   https://cubapoker-telegram-bot.onrender.com   (SIN barra final)');
  console.log('');
  console.log('  Luego abre el bot y pulsa el boton del menu. NO abras el enlace a mano.');

  process.exit(0);
})();