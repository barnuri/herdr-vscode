// Line comment
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Config<'a> {
    name: &'a str,
    retries: u32,
}

impl<'a> Config<'a> {
    pub fn new(name: &'a str) -> Self {
        let mut map: HashMap<String, i64> = HashMap::new();
        map.insert("x".to_string(), 42);
        if let Some(v) = map.get("x") {
            println!("value: {}\n", v);
        }
        Self { name, retries: 3 }
    }
}

const MAX: usize = 1_000;
