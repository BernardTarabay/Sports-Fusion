import { generateAnnouncement } from '../backend/src/integrations/whatsapp/announcements.js';

const game = {
  kickoffAt: '2026-09-04T18:00:00.000Z',   // 9:00 PM Beirut
  districtName: 'Beirut',
  venueName: 'Hoops Arena, Sin El Fil',
  venueMapsUrl: 'https://maps.app.goo.gl/example',
  capacity: 22,
  confirmedCount: 22,
  waitlistCount: 4,
  arriveByMinutes: 15,
  price: 10,
  currency: 'USD',
  publicUrl: 'https://sportsfusion.app/g/fri-beirut-x7k2',
};

const teams = [
  { color: 'black', players: [
    { assignedPosition: 'GK', name: 'Ahmad' }, { assignedPosition: 'LB', name: 'George' },
    { assignedPosition: 'CB', name: 'Tony' },  { assignedPosition: 'CB', name: 'Fadi' },
    { assignedPosition: 'RB', name: 'Michel' },{ assignedPosition: 'CDM', name: 'Jad' },
    { assignedPosition: 'CM', name: 'Mark' },  { assignedPosition: 'CM', name: 'Ziad' },
    { assignedPosition: 'LW', name: 'Chris' }, { assignedPosition: 'ST', name: 'Daniel' },
    { assignedPosition: 'RW', name: 'Bilal' },
  ]},
  { color: 'white', players: [
    { assignedPosition: 'GK', name: 'Karim' }, { assignedPosition: 'LB', name: 'Samir' },
    { assignedPosition: 'CB', name: 'Ali' },   { assignedPosition: 'CB', name: 'Joe' },
    { assignedPosition: 'RB', name: 'Nabil' }, { assignedPosition: 'CDM', name: 'Rami' },
    { assignedPosition: 'CM', name: 'Peter' }, { assignedPosition: 'CM', name: 'Hadi' },
    { assignedPosition: 'LW', name: 'Omar' },  { assignedPosition: 'ST', name: 'Elias' },
    { assignedPosition: 'RW', name: 'Walid' },
  ]},
];

const show = (label, text) => {
  console.log('\n' + '='.repeat(46));
  console.log('  ' + label);
  console.log('='.repeat(46));
  console.log(text);
};

show('registration_open', generateAnnouncement('registration_open', { ...game, confirmedCount: 0 }));
show('filling_up', generateAnnouncement('filling_up', { ...game, confirmedCount: 19 }));
show('game_full', generateAnnouncement('game_full', game));
show('teams', generateAnnouncement('teams', game, { teams }));
