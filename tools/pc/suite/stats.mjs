// The few statistics the PC suite reports. They live with the analyzers now
// (`tools/analysis/stats.mjs`), which the tablet's suite shares; this file
// stays so that nothing here has to change where it imports them from.
export { spread } from '../../analysis/stats.mjs'
