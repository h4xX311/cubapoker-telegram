import { useState, useEffect } from 'react';
import { Home } from './pages/Home';
import { Deposit } from './pages/Deposit';
import { Withdraw } from './pages/Withdraw';
import { Game } from './pages/Game';
import { Tournaments } from './pages/Tournaments';
import { VIP } from './pages/VIP';
import { Referrals } from './pages/Referrals';
import { Achievements } from './pages/Achievements';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        MainButton: {
          text: string;
          show: () => void;
          hide: () => void;
          onClick: (callback: () => void) => void;
        };
        themeParams: {
          bg_color?: string;
          text_color?: string;
          hint_color?: string;
          button_color?: string;
          button_text_color?: string;
        };
        initDataUnsafe?: {
          user?: {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
          };
        };
      };
    };
  }
}

type Page = 'home' | 'deposit' | 'withdraw' | 'game' | 'tournaments' | 'vip' | 'referrals' | 'achievements';

function App() {
  const [page, setPage] = useState<Page>('home');
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();

      const tgUser = window.Telegram.WebApp.initDataUnsafe?.user;
      if (tgUser) {
        setUser(tgUser);
        fetchUserData(tgUser.id);
      }
    }
  }, []);

  const fetchUserData = async (telegramId: number) => {
    try {
      const response = await fetch(`/api/user/${telegramId}`);
      const data = await response.json();
      if (data.user) {
        setUser((prev: any) => ({ ...prev, ...data.user }));
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    }
  };

  const renderPage = () => {
    switch (page) {
      case 'home':
        return <Home user={user} onNavigate={setPage} />;
      case 'deposit':
        return <Deposit user={user} onBack={() => setPage('home')} />;
      case 'withdraw':
        return <Withdraw user={user} onBack={() => setPage('home')} />;
      case 'game':
        return <Game user={user} onBack={() => setPage('home')} />;
      case 'tournaments':
        return <Tournaments user={user} onBack={() => setPage('home')} />;
      case 'vip':
        return <VIP user={user} onBack={() => setPage('home')} />;
      case 'referrals':
        return <Referrals user={user} onBack={() => setPage('home')} />;
      case 'achievements':
        return <Achievements user={user} onBack={() => setPage('home')} />;
      default:
        return <Home user={user} onNavigate={setPage} />;
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f1a] text-white">
      {renderPage()}
    </div>
  );
}

export default App;
