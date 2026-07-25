import { GUESSES } from '../data/guesses.js';
import { WORD_LEN } from './config.js';

// The dictionary gate, and the only thing TOPPLE needs from the word bank at
// runtime. (data/solutions.js is still used, but by decree.js alone, for the
// recognizability floor that keeps generated decrees humane.)
const GUESS_SET = new Set(GUESSES);

export function isValidGuess(word) {
  return typeof word === 'string' && word.length === WORD_LEN && GUESS_SET.has(word.toLowerCase());
}
