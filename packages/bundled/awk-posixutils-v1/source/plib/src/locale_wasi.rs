pub fn to_lower(c: char) -> char { c.to_lowercase().next().unwrap_or(c) }
pub fn to_upper(c: char) -> char { c.to_uppercase().next().unwrap_or(c) }
