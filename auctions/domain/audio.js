'use strict';

const AUDIO_SESSION_STATUSES = ['inactive', 'ready', 'live', 'paused', 'ended', 'failed'];

const TRANSITIONS = {
  inactive: ['ready', 'ended', 'failed'],
  ready: ['live', 'ended', 'failed'],
  live: ['paused', 'ended', 'failed'],
  paused: ['live', 'ended', 'failed'],
  ended: [],
  failed: [],
};

function canTransitionAudioSession(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function isActiveAudioStatus(status) {
  return ['inactive', 'ready', 'live', 'paused'].includes(status);
}

function audienceAudioLabel(status) {
  switch (status) {
    case 'live':
      return 'المحرّج مباشر صوتيًا';
    case 'ready':
    case 'inactive':
      return 'الصوت لم يبدأ';
    case 'paused':
      return 'الصوت متوقف مؤقتًا';
    case 'ended':
    case 'failed':
    default:
      return 'الصوت غير متاح';
  }
}

module.exports = {
  AUDIO_SESSION_STATUSES,
  canTransitionAudioSession,
  isActiveAudioStatus,
  audienceAudioLabel,
};
