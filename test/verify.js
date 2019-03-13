let randomBytes = require('crypto').pseudoRandomBytes
let test = require('tape')
let nacl = require('tweetnacl');

let {
  verifyCommit,
  getVoteSignBytes
} = require('../lib/verify.js')
let { getAddress } = require('../lib/pubkey.js')
let {
  getValidatorSetHash,
  getBlockHash
} = require('../lib/hash.js')

test('verifyCommit with mismatched header and commit', (t) => {
  let validators = genValidators()
  let header = genGenesisHeader(validators)
  let commit = genCommit(genGenesisHeader(validators), validators)
  t.throws(
    () => verifyCommit(header, commit, validators),
    'Commit does not match block hash'
  )
  t.end()
})

test('verifyCommit with mismatched header and precommit', (t) => {
  let validators = genValidators()
  let header = genGenesisHeader(validators)
  let commit = genCommit(header, validators)
  let commit2 = genCommit(genGenesisHeader(validators), validators)
  // copy a precommit for a different header
  commit.precommits[20] = commit2.precommits[20]
  t.throws(
    () => verifyCommit(header, commit, validators),
    'Precommit block hash does not match commit'
  )
  t.end()
})

function genGenesisHeader (validators) {
  let validatorsHash = getValidatorSetHash(validators)
  return {
    version: { block: 123, app: 456 },
    chain_id: Math.random().toString(36),
    height: 1,
    time: new Date().toISOString(),
    num_txs: 0,
    last_block_id: {
      hash: '',
      parts: { total: '0', hash: '' }
    },
    total_txs: 0,
    last_commit_hash: '',
    data_hash: '',
    validators_hash: validatorsHash,
    next_validators_hash: validatorsHash,
    consensus_hash: genHash(),
    app_hash: '',
    last_results_hash: '',
    evidence_hash: '',
    proposer_address: '0001020304050607080900010203040506070809'
  }
}

function genCommit (header, validators) {
  let blockId = {
    hash: getBlockHash(header),
    parts: {
      total: 1,
      hash: genHash()
    }
  }
  let precommits = []
  let time = new Date(header.time).getTime()
  for (let i = 0; i < validators.length; i++) {
    let validator = validators[i]
    let precommit = {
      validator_address: validator.address,
      validator_index: String(i),
      height: header.height,
      round: '0',
      timestamp: new Date(time + Math.random() * 1000).toISOString(),
      type: 2,
      block_id: blockId
    }
    let signBytes = Buffer.from(getVoteSignBytes(header.chain_id, precommit))
    let signature = nacl.sign.detached(signBytes, validator.priv_key);
    precommit.signature = {
      type: 'tendermint/SignatureEd25519',
      value: signature.toString('base64')
    }
    precommits.push(precommit)
  }
  return {
    block_id: blockId,
    precommits
  }
}

function genValidators () {
  let validators = []
  for (let i = 0; i < 100; i++) {
    let priv = randomBytes(32)
    let pub = {
      type: 'tendermint/PubKeyEd25519',
      value: priv.toString('base64')
    }
    validators.push({
      priv_key: priv,
      pub_key: pub,
      address: getAddress(pub),
      voting_power: '10',
      accum: '0'
    })
  }
  return validators
}

function genHash () {
  return randomBytes(20).toString('hex').toUpperCase()
}
