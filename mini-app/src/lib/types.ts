/** Tipos compartidos del Mini App. */

export const PAGES = [
  'home',
  'deposit',
  'withdraw',
  'game',
  'tournaments',
  'vip',
  'referrals',
  'achievements',
] as const;

export type Page = (typeof PAGES)[number];

export interface Session {
  id: string;
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  balance: {
    usdt: number;
    credits: number;
  };
  vip: string | null;
}

/** Resuelve la ruta de la URL a una pagina de la app. */
export const pageFromPath = (pathname: string): Page => {
  const segment = pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  return (PAGES as readonly string[]).includes(segment) ? (segment as Page) : 'home';
};
