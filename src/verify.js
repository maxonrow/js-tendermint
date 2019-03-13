'use strict'

const stringify = require('json-stable-stringify')
const nacl = require('tweetnacl');

// TODO: try to load native ed25519 implementation, fall back to supercop.js
const {
  getBlockHash,
  getValidatorSetHash
} = require('./hash.js')
const {
  VarBuffer,
  CanonicalVote
} = require('./types.js')
const { getAddress } = require('./pubkey.js')
const { safeParseInt } = require('./common.js')

// gets the serialized representation of a vote, which is used
// in the commit signatures
function getVoteSignBytes (chainId, vote) {
  let canonicalVote = Object.assign({}, vote)
  canonicalVote.chain_id = chainId
  canonicalVote.height = safeParseInt(vote.height)
  canonicalVote.round = safeParseInt(vote.round)
  canonicalVote.block_id.parts.total = safeParseInt(vote.block_id.parts.total)
  canonicalVote.validator_index = safeParseInt(vote.validator_index)
  let encodedVote = CanonicalVote.encode(canonicalVote)
  return VarBuffer.encode(encodedVote)
}

// verifies that a number is a positive integer, less than the
// maximum safe JS integer
function verifyPositiveInt (n) {
  if (!Number.isInteger(n)) {
    throw Error('Value must be an integer')
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw Error('Value must be < 2^53')
  }
  if (n < 0) {
    throw Error('Value must be >= 0')
  }
}

// verifies a commit signs the given header, with 2/3+ of
// the voting power from given validator set
function verifyCommit (header, commit, validators) {
  let blockHash = getBlockHash(header)

  if (blockHash !== commit.block_id.hash) {
    throw Error('Commit does not match block hash')
  }

  let countedValidators = new Array(validators.length)
  let roundNumber

  for (let precommit of commit.precommits) {
    // skip empty precommits
    if (precommit == null) continue

    precommit.height = safeParseInt(precommit.height)
    precommit.round = safeParseInt(precommit.round)

    // all fields of block ID must match commit
    if (precommit.block_id.hash !== commit.block_id.hash) {
      throw Error('Precommit block hash does not match commit')
    }
    if (safeParseInt(precommit.block_id.parts.total) !== safeParseInt(commit.block_id.parts.total)) {
      throw Error('Precommit parts count does not match commit')
    }
    if (precommit.block_id.parts.hash !== commit.block_id.parts.hash) {
      throw Error('Precommit parts hash does not match commit')
    }

    // height must match header
    if (precommit.height !== header.height) {
      throw Error('Precommit height does not match header')
    }

    // rounds of all precommits must match
    verifyPositiveInt(precommit.round)
    if (roundNumber == null) {
      roundNumber = precommit.round
    } else if (precommit.round !== roundNumber) {
      throw Error('Precommit rounds do not match')
    }

    // vote type must be 2 (precommit)
    if (precommit.type !== 2) {
      throw Error('Precommit has invalid type value')
    }

    // ensure there are never multiple precommits from a single validator
    if (countedValidators[precommit.validator_index]) {
      throw Error('Validator has multiple precommits')
    }
    countedValidators[precommit.validator_index] = true

    // ensure this precommit references the correct validator
    let validator = validators[precommit.validator_index]
    if (precommit.validator_address !== validator.address) {
      throw Error('Precommit address does not match validator')
    }
  }

  verifyCommitSigs(header, commit, validators)
}

// verifies a commit is signed by at least 2/3+ of the voting
// power of the given validator set
function verifyCommitSigs (header, commit, validators) {
  let committedVotingPower = 0

  // index validators by address
  let validatorsByAddress = {}
  for (let validator of validators) {
    validatorsByAddress[validator.address] = validator
  }

  for (let precommit of commit.precommits) {
    // skip empty precommits
    if (precommit == null) continue

    let validator = validatorsByAddress[precommit.validator_address]

    // skip if this validator isn't in the set
    // (we allow precommits from validators not in the set,
    // because we sometimes check the commit against older
    // validator sets)
    if (!validator) continue

    let signature = Buffer.from(precommit.signature, 'base64')
    let signBytes = getVoteSignBytes(header.chain_id, precommit)
    let pubKey = Buffer.from(validator.pub_key.value, 'base64')

    if (!nacl.sign.detached.verify(signBytes, signature, pubKey)) {
      throw Error('Invalid precommit signature')
    }

    // count this validator's voting power
    committedVotingPower += safeParseInt(validator.voting_power)
  }

  // sum all validators' voting power
  let totalVotingPower = validators.reduce(
    (sum, v) => sum + safeParseInt(v.voting_power), 0)
  // JS numbers have no loss of precision up to 2^53, but we
  // error at over 2^52 since we have to do arithmetic. apps
  // should be able to keep voting power lower than this anyway
  if (totalVotingPower > 2 ** 52) {
    throw Error('Total voting power must be less than 2^52')
  }

  // verify enough voting power signed
  let twoThirds = Math.ceil(totalVotingPower * 2 / 3)
  if (committedVotingPower < twoThirds) {
    let error = Error('Not enough committed voting power')
    error.insufficientVotingPower = true
    throw error
  }
}

// verifies that a validator set is in the correct format
// and hashes to the correct value
function verifyValidatorSet (validators, expectedHash) {
  for (let validator of validators) {
    if (getAddress(validator.pub_key) !== validator.address) {
      throw Error('Validator address does not match pubkey')
    }

    validator.voting_power = safeParseInt(validator.voting_power)
    verifyPositiveInt(validator.voting_power)
    if (validator.voting_power === 0) {
      throw Error('Validator voting power must be > 0')
    }
  }

  let validatorSetHash = getValidatorSetHash(validators)
  if (expectedHash != null && validatorSetHash !== expectedHash) {
    throw Error('Validator set does not match what we expected')
  }
}

// verifies transition from one block to a higher one, given
// each block's header, commit, and validator set
function verify (oldState, newState) {
  let oldHeader = oldState.header
  let oldValidators = oldState.validators
  let newHeader = newState.header
  let newValidators = newState.validators

  if (newHeader.chain_id !== oldHeader.chain_id) {
    throw Error('Chain IDs do not match')
  }
  if (newHeader.height <= oldHeader.height) {
    throw Error('New state height must be higher than old state height')
  }

  let validatorSetChanged =
    newHeader.validators_hash !== oldHeader.validators_hash
  if (validatorSetChanged && newValidators == null) {
    throw Error('Must specify new validator set')
  }

  // make sure new header has a valid commit
  let validators = validatorSetChanged
    ? newValidators : oldValidators
  verifyCommit(newHeader, newState.commit, validators)

  if (validatorSetChanged) {
    // make sure new validator set is valid

    // make sure new validator set has correct hash
    verifyValidatorSet(newValidators, newHeader.validators_hash)

    // if previous state's `next_validators_hash` matches the new validator
    // set hash, then we already know it is valid
    if (oldHeader.next_validators_hash !== newHeader.validators_hash) {
      // otherwise, make sure new commit is signed by 2/3+ of old validator set.
      // sometimes we will take this path to skip ahead, we don't need any
      // headers between `oldState` and `newState` if this check passes
      verifyCommitSigs(newHeader, newState.commit, oldValidators)
    }
  }
}

module.exports = verify
Object.assign(module.exports, {
  verifyCommit,
  verifyCommitSigs,
  verifyValidatorSet,
  verify,
  getVoteSignBytes
})
