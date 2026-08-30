// Where Sports Fusion lives off this site.
//
// One definition, because these end up in the footer, the account sheet, the landing
// page and the rewards screen, and four hand-typed copies of a WhatsApp invite link is
// three chances to paste a stale one.
//
// The WhatsApp community is first on purpose. It is where this league actually happened
// before any of this existed, it is still where most people find out about a game, and
// the honest thing for the website to do is point at it rather than pretend it replaced
// it.

export const SOCIAL_LINKS = [
  {
    key: 'whatsapp',
    label: 'WhatsApp community',
    short: 'WhatsApp',
    href: 'https://chat.whatsapp.com/H5cQROg0pjMGOqbbstmssy',
    description: 'The main group. Where the football gets arranged.',
    brand: '#25D366',
  },
  {
    key: 'store',
    label: 'Sports Fusion store',
    short: 'Store',
    href: 'https://sportsfusion.st/',
    description: 'Kit and merchandise. Points redeem here.',
    brand: '#00C06A',
  },
  {
    key: 'instagram',
    label: 'Instagram',
    short: 'Instagram',
    href: 'https://www.instagram.com/sportsfusion.co/',
    description: '@sportsfusion.co',
    brand: '#E1306C',
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    short: 'TikTok',
    href: 'https://www.tiktok.com/@sportsfusion.co',
    description: '@sportsfusion.co',
    brand: '#00F2EA',
  },
];

export const byKey = (key) => SOCIAL_LINKS.find((l) => l.key === key);

export const STORE_URL = byKey('store').href;
export const WHATSAPP_COMMUNITY_URL = byKey('whatsapp').href;

export default SOCIAL_LINKS;
