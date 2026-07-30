/*
  The running order. Reorder the deck by reordering this array; add a slide by
  copying any file in this directory and inserting it here.

  Every slide module exports:
    default    the component
    label      the eyebrow shown in the top-left chrome
    fragments  how many extra key presses the slide takes (0 = none)
    notes      the speaker notes, shown by pressing `n`
*/

import * as doesItWork from './01-does-it-work.jsx';
import * as asymmetry from './02-asymmetry.jsx';
import * as statusQuo from './03-status-quo.jsx';
import * as dontMakeMeClick from './04-dont-make-me-click.jsx';
import * as story from './05-story.jsx';
import * as loop from './06-loop.jsx';
import * as demo from './07-demo.jsx';
import * as webStudy from './08-web-study.jsx';
import * as apiStudy from './09-api-study.jsx';
import * as callback from './10-callback.jsx';
import * as questions from './11-questions.jsx';

export const slides = [
  doesItWork,
  asymmetry,
  statusQuo,
  dontMakeMeClick,
  story,
  loop,
  demo,
  webStudy,
  apiStudy,
  callback,
  questions,
];
