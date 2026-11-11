/* A roster row's acts as the Desktop offers them: the shared table (packages/client/instance-acts.mjs
   `instanceActs`), with each act the accepted CLI holds back above this Desktop's tested bound made not enabled,
   its reason the notice sentence (packages/client/above-tested.mjs `heldBackActs`, oats-project/oats#1879). The
   backend refuses those operations by itself; this only keeps the controls from offering them. */
import { instanceActs } from '../../client/instance-acts.mjs';
import { heldBackActs } from '../../client/above-tested.mjs';
import { cliStatus } from './views/cli-status.mjs';

export const desktopActs = (instance, cli = cliStatus()) => heldBackActs(instanceActs(instance), cli);
