use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EqualizerSettings {
    pub enabled: bool,
    pub preset: String,
    pub bands: Vec<f64>,
    pub preamp: f64,
}

impl Default for EqualizerSettings {
    fn default() -> Self {
        Self { enabled: false, preset: "flat".into(), bands: vec![0.; 10], preamp: 0. }
    }
}

impl EqualizerSettings {
    pub fn sanitize(&mut self) {
        if self.bands.len() != 10 || self.bands.iter().any(|value| !value.is_finite()) {
            self.bands = vec![0.; 10];
            self.preset = "flat".into();
        }
        for band in &mut self.bands { *band = ((*band * 10.).round() / 10.).clamp(-12., 12.); }
        self.preamp = if self.preamp.is_finite() { ((self.preamp * 10.).round() / 10.).clamp(-12., 0.) } else { 0. };
        if !["flat", "custom", "rap", "hip-hop", "pop", "rock", "electronic", "jazz", "classical"].contains(&self.preset.as_str()) {
            self.preset = "custom".into();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_restore_with_eq_disabled() {
        let settings: crate::Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.equalizer, EqualizerSettings::default());
    }

    #[test]
    fn native_persistence_keeps_the_entire_curve() {
        let mut state = crate::defaults();
        state.settings.equalizer = EqualizerSettings { enabled: true, preset: "custom".into(), bands: vec![1., 2., 3., 4., 5., 6., 7., 8., 9., 10.], preamp: -4.5 };
        let restored: crate::PersistedState = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        let restored = crate::sanitized(restored, &std::collections::HashMap::new());
        assert_eq!(restored.settings.equalizer, state.settings.equalizer);
    }

    #[test]
    fn repairs_unsafe_gains_and_incomplete_curves() {
        let mut eq = EqualizerSettings { enabled: true, preset: "unexpected".into(), bands: vec![99.; 10], preamp: f64::NAN };
        eq.sanitize();
        assert_eq!(eq.bands, vec![12.; 10]);
        assert_eq!(eq.preamp, 0.);
        assert_eq!(eq.preset, "custom");
        eq.bands[3] = f64::INFINITY;
        eq.sanitize();
        assert_eq!(eq.bands, vec![0.; 10]);
        eq.bands.pop();
        eq.sanitize();
        assert_eq!(eq.bands.len(), 10);
    }
}
