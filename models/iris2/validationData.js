const FS = require('fs');

const samples = 32;

let origPoolSize = Buffer.poolSize;
Buffer.poolSize = 900;

let data = new Float32Array(FS.readFileSync('./models/iris2/test/0').buffer);

Buffer.poolSize = origPoolSize;

const X = data.subarray(1, 129);
const Y = data.subarray(129);

module.exports = {
    getX: function() {
        return X;
    },
    getY: function() {
        return Y;
    }
};