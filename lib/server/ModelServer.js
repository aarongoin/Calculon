const FS = require('fs');
const Pako = require('pako');
const DumbClient = require('./clients/DumbClient');
const Watcher = require('./clients/WatcherClient');
const TemplateValidator = require('./TemplateValidator');
const Validator = require('./Validator');

function DEFLATE(dataArray) {
    return Buffer.from(
        Pako.deflateRaw(
            new Uint8Array(dataArray.buffer)
        ).buffer
    );
}
function INFLATE(arraybuffer, type) {
    return new global[type](
        Pako.inflateRaw(
            new Uint8Array(arraybuffer)
        ).buffer
    );
}

module.exports = class ModelServer {
    constructor(modelPath) {
        // open model for training
        this.path = modelPath;
        this.model = require(modelPath + 'model.js');
        this.config = require(modelPath + 'config.js');
        this.counter = 0;

        console.log('Validating model file...');
        // run through validation first to catch issues with setup
        TemplateValidator.model(this.model, modelPath.split('/')[3]);
        console.log('Validating config file...');
        TemplateValidator.config(this.config, modelPath.split('/')[3]);

        this.hasWatcher = false;
        this.watcherData = { validation: [] };

        let generatingWeights = false;

        // hold current weights in memory--if no weights then generate them
        if (FS.existsSync(modelPath + 'weights.bin')) {
            console.log('Loading model weights...');
            let origPoolSize = Buffer.poolSize;
            Buffer.poolSize = modelSize * ( this.config.byte_weights ? 1 : 4 );
            this.currentWeights = FS.readFileSync(modelPath + 'weights.bin');
            Buffer.poolSize = origPoolSize;
        } else {
            generatingWeights = true;
        }
        console.log('Starting model Validator...');
        // open model validator
        this.validator = new Validator([].concat(this.model), this.config.validation.data_delegate, this.config.byte_weights);
        if (generatingWeights) {
            console.log('Generating model weights...');
            this.currentWeights = this.validator.getWeights();
        }
        console.log('Linking with model training delegate...');
        this.training = this.config.training.data_delegate || null;

        this.merging = {}; // holds weights from clients sent to another client to be merged
        this.toMerge = DEFLATE(this.currentWeights); // most recent client update
        this.needsMerged = false;

        this.afterValidation = this.afterValidation.bind(this);

    }

    getWeights() {
        return DEFLATE(this.currentWeights);
    }

    putWeights(client, weights) {
        // exchange weights
        let toMerge = this.toMerge;
        this.toMerge = weights;
        // keep hold of weights we're sending to this client to prevent data loss
        this.merging[client] = toMerge;
        this.needsMerged = true;

        return toMerge;
    }

    mergeAll() {
        // merge all weights to single set and set to currentWeights
        let type = this.config.byte_weights ? 'Int8Array' : 'Float32Array';
        let toMerge = INFLATE(this.toMerge, type);
        this.toMerge = null;
        if (Object.keys(this.merging).length === 1)
            return toMerge;
        for (let zWeights of this.merging) {
            if (zWeights) {
                let weights = INFLATE(zWeights, type);
                // average the weights (on the CPU)
                for (let i in weights) {
                    toMerge[i] += weights[i]; 
                    toMerge[i] *= 0.5;
                }
            }
        }
        this.currentWeights = toMerge;
        this.needsMerged = false;
    }

    getLearningRate() {
        return Buffer.from(new Float32Array([this.config.training.learning_rate]).buffer);
    }

    getData() {
        return DEFLATE(
            this.training.getBatch(this.config.training.batch_size)
        );
    }

    saveModel() {
        // save model to disk
        if (this.needsMerged) this.mergeAll();
        FS.writeFileSync(this.currentWeights.buffer, this.path + 'weights.bin');
    }

    getClient() {
        // create dumb client if need be, and return it
        if (!this.dumb_client) {
            let parsedPath = this.path.split('/');
            // pass dumb client the name of the model and the model description
            this.dumb_client = Pako.gzip( DumbClient( parsedPath[ parsedPath.length - 2 ], JSON.stringify(this.model) ), this.config.byte_weights, this.config.training.byte_data ).buffer;
        }
        return Buffer.from(this.dumb_client);
    }

    getWatcher() {
        return Buffer.from( Pako.gzip( Watcher(this.path) ).buffer );
    }

    getWatcherData() {
        let data = this.watcherData;
        this.watcherData = { validation: [] };
        return Buffer.from(
            Pako.gzip(
                JSON.stringify(data)
            ).buffer
        );
    }

    stop() {
        // TODO: shutdown gracefully
        if (this.validationInterval)
            global.clearInterval(this.validationInterval);
        
        if (this.needsMerged)
            this.mergeAll();
        this.saveModel();
    }

    start() {
        this.validationInterval = global.setInterval(this.validate.bind(this), (this.config.validation.validate_every * 1000) << 0);
    }

    validate() {
        if (this.config.validation.merge_all) {
            if (this.needsMerged)
                this.mergeAll();
            this.validator.validateWeights(this.currentWeights, this.afterValidation);
            // TODO: queue merged weights for dispatch to every client
        } else {
            let type = this.config.byte_weights ? 'Int8Array' : 'Float32Array';
            this.validator.validateWeights( INFLATE(this.toMerge, type), this.afterValidation );
        }
    }

    afterValidation(accuracy) {
        this.watcherData.validation.push({ x: this.counter++, y: accuracy * 100 });
    }
}