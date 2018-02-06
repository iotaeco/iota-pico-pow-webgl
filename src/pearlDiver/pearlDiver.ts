import { CoreError } from "@iota-pico/core/dist/error/coreError";
import { Curl } from "@iota-pico/crypto/dist/tritHashers/curl";
import { Trits } from "@iota-pico/data/dist/data/trits";
import { Trytes } from "@iota-pico/data/dist/data/trytes";
import add from "../shaders/add";
import checkCol from "../shaders/checkCol";
import checkDo from "../shaders/checkDo";
import checkK from "../shaders/checkK";
import finalize from "../shaders/finalize";
import headers from "../shaders/headers";
import increment from "../shaders/increment";
import init from "../shaders/init";
import transform from "../shaders/transform";
import { WebGLWorker } from "../webGL/webGLWorker";
import { PearlDiverSearchObject } from "./pearlDiverSearchObject";
import { PearlDiverSearchStates } from "./pearlDiverSearchStates";
import { PearlDiverState } from "./pearlDiverState";
/**
 * PearlDiver.
 * Converted from https://github.com/iotaledger/curl.lib.js/blob/master/src/pearldiver.js
 */
export class PearlDiver {
    public static instance: PearlDiver;

    /* @internal */
    private static readonly TRANSACTION_LENGTH: number = Curl.HASH_LENGTH * 33;
    /* @internal */
    private static readonly TEXEL_SIZE: number = 4;
    /* @internal */
    private static readonly NONCE_LENGTH: number = Curl.HASH_LENGTH / 3;
    /* @internal */
    private static readonly NONCE_START: number = Curl.HASH_LENGTH - PearlDiver.NONCE_LENGTH;

    /* @internal */
    private static readonly LOW_BITS: number = 0; // 00000000
    /* @internal */
    private static readonly HIGH_BITS: number = -1; // 0xFFFFFFFF,FFFFFFFF,4294967295
    /* @internal */
    private static readonly LOW_0: number = 0xDB6DB6DB; // 6DB6DB6D,
    /* @internal */
    private static readonly LOW_1: number = 0xF1F8FC7E; // 3F1F8FC7,
    /* @internal */
    private static readonly LOW_2: number = 0x7FFFE00F; // FFFC01FF,
    /* @internal */
    private static readonly LOW_3: number = 0xFFC00000; // 07FFFFFF,
    /* @internal */
    private static readonly HIGH_0: number = 0xB6DB6DB6; // DB6DB6DB,
    /* @internal */
    private static readonly HIGH_1: number = 0x8FC7E3F1; // F8FC7E3F,
    /* @internal */
    private static readonly HIGH_2: number = 0xFFC01FFF; // F803FFFF,
    /* @internal */
    private static readonly HIGH_3: number = 0x003FFFFF; //FFFFFFFF,

    /* @internal */
    private readonly _webGLWorker: WebGLWorker;
    /* @internal */
    private readonly _queue: PearlDiverSearchObject[];
    /* @internal */
    private readonly _currentBuffer: Int32Array;
    /* @internal */
    private _offset: number;
    /* @internal */
    private _state: PearlDiverState;

    /* @internal */
    private constructor() {
        this._webGLWorker = new WebGLWorker();
        /* false positive */
        /* tslint:disable restrict-plus-operands */
        this._webGLWorker.initialize(Curl.STATE_LENGTH + 1, PearlDiver.TEXEL_SIZE);
        this._offset = 0;
        this._currentBuffer = this._webGLWorker.getIpt().data;
        this._webGLWorker.addProgram("init", headers + add + init, "gr_offset");
        this._webGLWorker.addProgram("increment", headers + add + increment);
        this._webGLWorker.addProgram("twist", headers + transform);
        this._webGLWorker.addProgram("check", headers + checkDo + checkK, "minWeightMagnitude");
        this._webGLWorker.addProgram("col_check", headers + checkCol);
        this._webGLWorker.addProgram("finalize", headers + checkDo + finalize);
        this._state = PearlDiverState.ready;
        this._queue = [];
    }

    /**
     * Intialize the PearlDiver main instance.
     */
    public static initialize(): void {
        if (!PearlDiver.instance) {
            PearlDiver.instance = new PearlDiver();
        }
    }

    /**
     * Perform a search using trytes.
     * @param trytes The trytes to perform the search on.
     * @param minWeightMagnitude The minimum weight magnitude.
     * @returns Promise which resolves to the trytes from the search.
     */
    public async searchWithTrytes(trytes: Trytes, minWeightMagnitude: number): Promise<Trytes> {
        const searchStates = this.prepare(trytes);
        return this.search(searchStates, minWeightMagnitude);
    }

    /**
     * Sets an offset to start pow search from
     * @param offset The offset to start the search from.
     */
    public setOffset(offset: number): void {
        this._offset = offset;
    }

    /**
     * Interrupts the currently running proof-of-work function.
     */
    public interrupt(): void {
        if (this._state === PearlDiverState.searching) {
            this._state = PearlDiverState.interrupted;
        }
    }

    /**
     * Continues the proof-of-work that you just interrupted.
     */
    public resume(): void {
        this.searchDoNext();
    }

    /**
     * Removes the proof-of-work job that you had previously queued.
     */
    public remove(): void {
        this._queue.pop();
    }

    /* @internal */
    private prepare(transactionTrytes: Trytes): PearlDiverSearchStates {
        const curl = new Curl();
        curl.initialize();
        const transactionTrits = Trits.fromTrytes(transactionTrytes);
        curl.absorb(transactionTrits, 0, PearlDiver.TRANSACTION_LENGTH - Curl.HASH_LENGTH);
        const tritData = transactionTrits.toValue();
        const curlState = curl.getState();
        tritData
            .slice(PearlDiver.TRANSACTION_LENGTH - Curl.HASH_LENGTH, PearlDiver.TRANSACTION_LENGTH)
            .forEach((value: number, index: number) => {
                curlState[index] = value;
            });
        return this.searchToPair(curlState);
    }

    /* @internal */
    private async search(states: PearlDiverSearchStates, minWeight: number): Promise<Trytes> {
        if (minWeight >= Curl.HASH_LENGTH || minWeight <= 0) {
            return Promise.reject(new CoreError("Bad Min-Weight Magnitude", { minWeight }));
        }

        // promise will complete when the search has completed
        // tslint:disable-next-line:promise-must-complete
        return new Promise<Trytes>((resolve, reject) => {
            this._queue.push({
                states: states,
                minWeightMagnitude: minWeight,
                callback: resolve
            });
            if (this._state === PearlDiverState.ready) {
                this.searchDoNext();
            }
        });
    }

    /* @internal */
    private searchToPair(state: number[]): PearlDiverSearchStates {
        const states = {
            low: new Int32Array(Curl.STATE_LENGTH),
            high: new Int32Array(Curl.STATE_LENGTH)
        };
        state.forEach((trit: number, index: number) => {
            switch (trit) {
                case 0:
                    states.low[index] = PearlDiver.HIGH_BITS;
                    states.high[index] = PearlDiver.HIGH_BITS;
                    break;
                case 1:
                    states.low[index] = PearlDiver.LOW_BITS;
                    states.high[index] = PearlDiver.HIGH_BITS;
                    break;
                default:
                    states.low[index] = PearlDiver.HIGH_BITS;
                    states.high[index] = PearlDiver.LOW_BITS;
            }
        });
        this.searchOffset(states, PearlDiver.NONCE_START);
        return states;
    }

    /* @internal */
    private searchOffset(states: PearlDiverSearchStates, offset: number): void {
        states.low[offset + 0] = PearlDiver.LOW_0;
        states.low[offset + 1] = PearlDiver.LOW_1;
        states.low[offset + 2] = PearlDiver.LOW_2;
        states.low[offset + 3] = PearlDiver.LOW_3;
        states.high[offset + 0] = PearlDiver.HIGH_0;
        states.high[offset + 1] = PearlDiver.HIGH_1;
        states.high[offset + 2] = PearlDiver.HIGH_2;
        states.high[offset + 3] = PearlDiver.HIGH_3;
    }

    /* @internal */
    private searchDoNext(): void {
        const next = this._queue.shift();
        if (this._state !== PearlDiverState.searching) {
            this._state = PearlDiverState.searching;
            this.webGLFindNonce(next);
        } else {
            this._state = PearlDiverState.ready;
        }
    }

    /* @internal */
    private webGLFindNonce(searchObject: PearlDiverSearchObject): void {
        this.webGLWriteBuffers(searchObject.states);
        this._webGLWorker.writeData(this._currentBuffer);
        this._webGLWorker.runProgram("init", 1, { name: "gr_offset", value: this._offset });
        setTimeout(() => this.webGLSearch(searchObject), 1);
    }

    /* @internal */
    private webGLWriteBuffers(states: PearlDiverSearchStates): void {
        for (let i = 0; i < Curl.STATE_LENGTH; i++) {
            this._currentBuffer[i * PearlDiver.TEXEL_SIZE] = states.low[i];
            this._currentBuffer[i * PearlDiver.TEXEL_SIZE + 1] = states.high[i];
            this._currentBuffer[i * PearlDiver.TEXEL_SIZE + 2] = states.low[i];
            this._currentBuffer[i * PearlDiver.TEXEL_SIZE + 3] = states.high[i];
        }
    }

    /* @internal */
    private webGLSearch(searchObject: PearlDiverSearchObject): void {
        this._webGLWorker.runProgram("increment", 1);
        this._webGLWorker.runProgram("twist", Curl.NUMBER_OF_ROUNDS);
        this._webGLWorker.runProgram("check", 1, { name: "minWeightMagnitude", value: searchObject.minWeightMagnitude });
        this._webGLWorker.runProgram("col_check", 1);

        if (this._webGLWorker.readData(Curl.STATE_LENGTH, 0, 1, 1)[2] === -1) {
            if (this._state === PearlDiverState.interrupted) {
                return this.saveSearch(searchObject);
            }
            setTimeout(() => this.webGLSearch(searchObject), 1);
        } else {
            this._webGLWorker.runProgram("finalize", 1);
            const nonce = this._webGLWorker.readData(0, 0, this._webGLWorker.getDimensions().x, 1)
                .reduce(this.pack(4), [])
                .slice(0, Curl.HASH_LENGTH)
                .map(x => x[3]);
            searchObject.callback(Trits.fromValue(nonce).toTrytes());
            this.searchDoNext();
        }
    }

    /* @internal */
    private saveSearch(searchObject: PearlDiverSearchObject): void {
        this._currentBuffer
            .reduce(this.pack(4), [])
            .slice(0, Curl.STATE_LENGTH)
            .reduce((a: number[][], v: number[]) => a.map((c: number[], i: number) => c.push(v[i])) && a, [[], []])
            .reduce((a: Map<string, number[]>, v: number[], i: number) => (i % 2 ? a.set("high", v) : a.set("low", v)) && a, new Map())
            .forEach((v: Int32Array, k: string) => k === "low" ? searchObject.states.low = v : searchObject.states.high = v);

        this._queue.unshift(searchObject);
    }

    /* @internal */
    private pack(l: number): (r: number[][], currentValue: number, currentIndex: number) => number[][] {
        return (r: number[][], currentValue, currentIndex) => (currentIndex % l === 0 ? r.push([currentValue]) : r[r.length - 1].push(currentValue)) && r;
    }
}