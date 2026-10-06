import { useState, useEffect, useCallback } from 'react';
import { Home } from './pages/Home';
import { Deposit } from './pages/Deposit';
import { Withdraw } from './pages/Withdraw';
import { Tournaments } from './pages/Tournaments';
import { VIP } from './pages/VIP';
import { Referrals } from './pages/Referrals';
import { Achievements } from './pages/Achievements';
import { Tables } from './pages/Tables';
import { Table } from './pages/Table';
import { Centroll } from './pages/Centroll';
import { Freeroll } from './pages/Freeroll';
import { SimulatePay } from './pages/SimulatePay';
import { api, ApiError, type DepositOrder } from './lib/api';
import { pageFromPath as resolvePage, type Page, type Session } from './lib/types';

export default function App() {
  const [page, setPage] = useState<Page>(() => resolvePage(window.location.pathname));
  const [user, setUser] = useState<Session | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unauthorized' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [errorCode, setErrorCode] = useState<string>('');
  const [checkout, setCheckout] = useState<DepositOrder | null>(null);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  /** Tipo de cambio de referencia para mostrar el equivalente en CUP. */
  const [cupPerUsdt, setCupPerUsdt] = useState(120);

  /**
   * El saldo vive en un unico sitio y se refresca tras cada accion que lo
   * mueve (deposito, retiro, partida). Antes cada pagina tenia su propia copia
   * y la barra superior mostraba un valor obsoleto.
   */
  const refreshUser = useCallback(async () => {
    try {
      const data = await api.me();
      if (data.user) setUser(data.user);
      return data.user as Session;
    } catch {
      return null;
    }
  }, []);

  // Inicializacion: conectar con Telegram y cargar sesion
  useEffect(() => {
    const tg = window.Telegram?.WebApp;

    if (tg) {
      tg.ready();
      tg.expand();
    }

    // Sin initData no hay forma de validar identidad: fuera de Telegram
    // no se puede usar la app (ni debe permitirse).
    // ------------------------------------------------------------------
    // FUERA DE TELEGRAM, SOLO EN DESARROLLO
    //
    // Sin `initData` no hay forma de validar quien es el usuario, y sin esa
    // validacion cualquiera podria suplantar cualquier cuenta. En produccion esta
    // pantalla tiene que negarse a mostrarse, y se niega.
    //
    // Para developing, `import.meta.env.DEV` es `true` solo en el servidor de Vite y
    // va incrustado como `false` al compilar: esta rama desaparece del build de
    // produccion. El backend tampoco aceptaria nada, porque exige `NODE_ENV` distinto
    // de `production` para el bypass.
    //
    // Aun asi, que se note en la pantalla cuando se esta viendo una sesion falsa: si no,
    // un cambio puede parecer correcto sobre un usuario de pruebas y fallar con uno
    // de verdad.
    // ------------------------------------------------------------------
    if (!tg?.initData && !import.meta.env.DEV) {
      setStatus('unauthorized');
      setErrorMessage('Esta aplicacion solo funciona dentro de Telegram.');
      return;
    }

    (async () => {
      try {
        const data = await api.me();
        setUser(data.user);
        setStatus('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setStatus('unauthorized');
        setErrorCode(error.code ?? '');
        setErrorMessage(
          error.code === 'OPEN_FROM_TELEGRAM'
            ? 'Abre CubaPoker desde el chat del bot. Esta pantalla solo funciona dentro de Telegram.'
            : 'Tu sesión expiró. Reabre la aplicación desde el bot.',
        );
      } else {
        setStatus('error');
        setErrorMessage(
          error instanceof Error ? error.message : 'Error de conexión con el servidor.',
        );
      }
    }
  })();
}, []);

  const navigate = useCallback((next: Page) => {
    setPage(next);
    // Mantiene la URL sincronizada para que recargar no rompa la navegacion
    // y para que el bot pueda abrir directamente una seccion.
    const path = next === 'home' ? '/' : `/${next}`;
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
  }, []);

  // Soporte para el boton "atras" del navegador / gesto de Telegram
  useEffect(() => {
    const onPop = () => setPage(resolvePage(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Tipo de cambio de referencia: lo manda el servidor para que el cliente no
  // tenga una copia que se pueda desincronizar.
  useEffect(() => {
    let cancelled = false;
    api
      .gameConfig()
      .then((cfg) => {
        if (!cancelled && cfg?.cupPerUsdt) setCupPerUsdt(cfg.cupPerUsdt);
      })
      .catch(() => {
        /* el valor por defecto (120) es suficiente si falla */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Estados de carga / error a pantalla completa ---

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mb-5 animate-pulse">
          <span className="text-3xl">🃏</span>
        </div>
        <p className="text-[#a0a0b0]">Cargando tu cuenta…</p>
      </div>
    );
  }

  if (status === 'unauthorized' || status === 'error') {
    const openedOutside = errorCode === 'OPEN_FROM_TELEGRAM';

    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-[#ff4757]/20 flex items-center justify-center mb-5">
          <span className="text-3xl">{openedOutside ? '📱' : '⚠️'}</span>
        </div>
        <h1 className="text-xl font-bold mb-2">
          {openedOutside ? 'Ábrelo desde Telegram' : status === 'unauthorized' ? 'Sesión expirada' : 'Algo salió mal'}
        </h1>
        <p className="text-[#a0a0b0] mb-6 max-w-sm leading-relaxed">{errorMessage}</p>

        <button onClick={() => window.location.reload()} className="btn btn-primary px-6 py-3 mb-3">
          Reintentar
        </button>

        <p className="text-xs text-[#6c6c80] max-w-xs">
          CubaPoker es una Mini App: necesita ejecutarse dentro de Telegram para poder
          verificar tu identidad de forma segura.
        </p>
      </div>
    );
  }

  const back = () => navigate('home');

  // Checkout de pago (modo simulación): tiene prioridad sobre la navegación
  if (checkout) {
    return (
      <div className="min-h-screen bg-[#0f0f1a]">
        <SimulatePay
          order={checkout}
          onDone={async () => {
            await refreshUser();
            setCheckout(null);
            navigate('deposit');
          }}
          onCancel={() => setCheckout(null)}
          onBack={() => setCheckout(null)}
        />
      </div>
    );
  }

  const renderPage = () => {
    switch (page) {
      case 'home':
        return (
          <Home user={user} onNavigate={navigate} cupPerUsdt={cupPerUsdt} />
        );
      case 'deposit':
        return (
          <Deposit
            user={user}
            onBack={back}
            onBalanceChange={refreshUser}
            onCheckout={setCheckout}
          />
        );
      case 'withdraw':
        return <Withdraw user={user} onBack={back} onBalanceChange={refreshUser} />;
      case 'tables':
        return (
          <Tables
            user={user}
            onBack={back}
            onBalanceChange={refreshUser}
            onPlay={setActiveTable}
            cupPerUsdt={cupPerUsdt}
          />
        );
      case 'freeroll':
        return (
          <Freeroll
            onBack={back}
            onBalanceChange={refreshUser}
            onPlay={setActiveTable}
            cupPerUsdt={cupPerUsdt}
          />
        );
      case 'centroll':
        return (
          <Centroll
            user={user}
            onBack={back}
            onBalanceChange={refreshUser}
            onPlay={setActiveTable}
            cupPerUsdt={cupPerUsdt}
          />
        );
      case 'game':
        return activeTable ? (
          <Table
            tableId={activeTable}
            user={user}
            onBack={() => setActiveTable(null)}
            onBalanceChange={refreshUser}
          />
        ) : (
          <Home user={user} onNavigate={navigate} cupPerUsdt={cupPerUsdt} />
        );
      case 'tournaments':
        return <Tournaments user={user} onBack={back} onBalanceChange={refreshUser} />;
      case 'vip':
        return <VIP user={user} onBack={back} onBalanceChange={refreshUser} />;
      case 'referrals':
        return <Referrals user={user} onBack={back} />;
      case 'achievements':
        return <Achievements onBack={back} />;
      default:
        return (
          <Home user={user} onNavigate={navigate} cupPerUsdt={cupPerUsdt} />
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f1a] text-white">
      {/* Barra superior con saldo sincronizado */}
      <header className="sticky top-0 z-40 bg-[#0f0f1a]/95 backdrop-blur border-b border-[#2a2a4a]">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <button
            onClick={() => navigate('home')}
            className="flex items-center gap-2 font-bold"
            aria-label="Ir al inicio"
          >
            <span className="text-xl">🃏</span>
            <span className="text-[#ffd700]">CubaPoker</span>
          </button>

          <div className="flex items-center gap-2">
            {user?.vip && (
              <span className="badge badge-warning text-[10px] uppercase">
                {user.vip}
              </span>
            )}
            <button
              onClick={() => navigate('deposit')}
              className="chip chip-medium chip-green text-white font-bold"
              aria-label="Depositar"
              title="Depositar"
            >
              +
            </button>
            {/* Saldo total: real (retirable) + promocion (solo jugar).
                La distincion se explica en Home y en la pantalla de retiro. */}
            <button
              onClick={() => navigate('home')}
              className="flex flex-col items-end leading-none"
              title="Real + promoción"
            >
              <span className="text-sm font-bold text-[#00d26a]">
                {user?.balance.total ?? 0}
              </span>
              <span className="text-[10px] text-[#a0a0b0]">CUP</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto">{renderPage()}</main>
    </div>
  );
}
