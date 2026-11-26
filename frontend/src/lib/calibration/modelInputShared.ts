// The model input the calibration panels share (issue #913; ./modelInput.ts): one load per project and revision.
import { api } from '#lib/api/index.js';
import { SharedModelInput } from './modelInput';

export const calibrationModelInput = new SharedModelInput((id) => api.runs.modelInput(id));
