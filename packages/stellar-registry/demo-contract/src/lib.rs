#![no_std]
use soroban_sdk::{contract,contractimpl,contracttype,Address,Bytes,BytesN,Env,String,Symbol,Vec};
#[contracttype]
#[derive(Clone)]
pub struct Record { pub count: u64, pub active: bool, pub note: Option<u32> }
#[contract]
pub struct Demo;
#[contractimpl]
impl Demo {
 pub fn count(env: Env) -> u32 { env.storage().instance().get(&0u32).unwrap_or(0) }
 pub fn increment(env: Env) -> u32 { let n=Self::count(env.clone())+1;env.storage().instance().set(&0u32,&n);n }
 pub fn authorized(user: Address) -> bool {user.require_auth();true}
 pub fn echo_bool(v: bool) -> bool {v}
 pub fn echo_u32(v: u32) -> u32 {v}
 pub fn echo_i32(v: i32) -> i32 {v}
 pub fn echo_u64(v: u64) -> u64 {v}
 pub fn echo_i64(v: i64) -> i64 {v}
 pub fn echo_u128(v: u128) -> u128 {v}
 pub fn echo_i128(v: i128) -> i128 {v}
 pub fn echo_symbol(v: Symbol) -> Symbol {v}
 pub fn echo_address(v: Address) -> Address {v}
 pub fn echo_bytes(v: Bytes) -> Bytes {v}
 pub fn echo_fixed(v: BytesN<32>) -> BytesN<32> {v}
 pub fn echo_string(v: String) -> String {v}
 pub fn echo_option(v: Option<u64>) -> Option<u64> {v}
 pub fn echo_vec(v: Vec<u64>) -> Vec<u64> {v}
 pub fn echo_record(v: Record) -> Record {v}
 pub fn no_value() {}
 pub fn unsupported(v: Vec<Vec<u32>>) -> Vec<Vec<u32>> {v}
}
